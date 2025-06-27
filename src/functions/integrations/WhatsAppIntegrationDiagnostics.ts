// src/functions/integrations/WhatsAppIntegrationDiagnostics.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createLogger } from "../../shared/utils/logger";
import { JwtService } from "../../shared/utils/jwt.service";
import { toAppError } from "../../shared/utils/error.utils";
import { StorageService } from "../../shared/services/storage.service";
import { STORAGE_TABLES } from "../../shared/constants";
import { Integration, IntegrationStatus, IntegrationWhatsAppConfig } from "../../shared/models/integration.model";
import fetch from "node-fetch";

export async function diagnoseWhatsAppIntegration(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = createLogger(context);
    logger.info("WhatsAppIntegrationDiagnostics function processed a request.");

    try {
        // Verificar autenticación
        const authHeader = request.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return { status: 401, jsonBody: { error: "Se requiere autenticación de plataforma." } };
        }

        const token = authHeader.split(' ')[1];
        const jwtService = new JwtService();
        let platformUserPayload;
        try {
            platformUserPayload = jwtService.verifyToken(token);
        } catch (error) {
            return { status: 401, jsonBody: { error: "Token de plataforma inválido o expirado." } };
        }

        const platformUserId = platformUserPayload.userId;
        const integrationId = request.query.get("integrationId");
        const agentId = request.query.get("agentId");

        if (!integrationId || !agentId) {
            return { status: 400, jsonBody: { error: "Se requieren los parámetros 'integrationId' y 'agentId'." } };
        }

        const storageService = new StorageService();
        const integrationsTable = storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);

        // Obtener la integración
        let integration: Integration;
        try {
            const integrationEntity = await integrationsTable.getEntity(agentId, integrationId);
            integration = integrationEntity as unknown as Integration;
        } catch (error) {
            return { status: 404, jsonBody: { error: "Integración no encontrada." } };
        }

        // Verificar permisos
        if (integration.ownerUserId !== platformUserId) {
            return { status: 403, jsonBody: { error: "No tienes permiso para acceder a esta integración." } };
        }

        const config = typeof integration.config === 'string' 
            ? JSON.parse(integration.config) as IntegrationWhatsAppConfig
            : integration.config as IntegrationWhatsAppConfig;

        const accessToken = config.accessToken;

        logger.info(`Diagnosticando integración ${integrationId} para agente ${agentId}`);

        // 🔍 DIAGNÓSTICO 1: Verificar token de acceso
        const tokenCheckResult = await checkAccessToken(accessToken, logger);
        
        // 🔍 DIAGNÓSTICO 2: Obtener WABAs disponibles
        const wabaResult = await fetchUserWABAs(accessToken, logger);
        
        // 🔍 DIAGNÓSTICO 3: Obtener permisos del token
        const permissionsResult = await checkTokenPermissions(accessToken, logger);

        const diagnostics = {
            integrationId,
            currentStatus: integration.status,
            currentConfig: {
                phoneNumberId: config.phoneNumberId,
                businessAccountId: config.businessAccountId,
                phoneNumber: config.phoneNumber,
                displayName: config.displayName
            },
            diagnostics: {
                tokenValid: tokenCheckResult.valid,
                tokenInfo: tokenCheckResult.info,
                permissions: permissionsResult,
                availableWABAs: wabaResult.wabas,
                wabaFetchError: wabaResult.error
            }
        };

        // 🔧 AUTO-COMPLETAR si encontramos datos válidos
        if (wabaResult.wabas && wabaResult.wabas.length > 0) {
            const firstWaba = wabaResult.wabas[0];
            if (firstWaba.phone_numbers && firstWaba.phone_numbers.data && firstWaba.phone_numbers.data.length > 0) {
                const firstPhone = firstWaba.phone_numbers.data[0];
                
                // Actualizar la configuración
                const updatedConfig: IntegrationWhatsAppConfig = {
                    ...config,
                    phoneNumberId: firstPhone.id,
                    businessAccountId: firstWaba.id,
                    phoneNumber: firstPhone.display_phone_number,
                    displayName: firstPhone.verified_name || `WhatsApp (${firstPhone.display_phone_number})`
                };

                await integrationsTable.updateEntity({
                    partitionKey: agentId,
                    rowKey: integrationId,
                    config: JSON.stringify(updatedConfig),
                    status: IntegrationStatus.ACTIVE,
                    name: `WhatsApp handoff - ${updatedConfig.displayName}`,
                    updatedAt: Date.now()
                }, "Merge");

                logger.info(`Integración ${integrationId} auto-completada con WABA ${firstWaba.id} y teléfono ${firstPhone.id}`);

                return {
                    status: 200,
                    jsonBody: {
                        ...diagnostics,
                        autoCompleted: true,
                        updatedConfig: {
                            phoneNumberId: firstPhone.id,
                            businessAccountId: firstWaba.id,
                            phoneNumber: firstPhone.display_phone_number,
                            displayName: updatedConfig.displayName
                        },
                        newStatus: IntegrationStatus.ACTIVE
                    }
                };
            }
        }

        return {
            status: 200,
            jsonBody: {
                ...diagnostics,
                autoCompleted: false,
                recommendation: wabaResult.error 
                    ? "Error al obtener WABAs. Verifica los permisos del token."
                    : "No se encontraron WABAs o números de teléfono disponibles."
            }
        };

    } catch (error) {
        logger.error("Error en WhatsAppIntegrationDiagnostics:", error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
}

async function checkAccessToken(accessToken: string, logger: any): Promise<{ valid: boolean; info?: any }> {
    try {
        const response = await fetch(`https://graph.facebook.com/v22.0/me?access_token=${accessToken}`);
        const data = await response.json();
        
        if (response.ok) {
            return { valid: true, info: data };
        } else {
            logger.warn("Token de acceso inválido:", data);
            return { valid: false, info: data };
        }
    } catch (error) {
        logger.error("Error verificando token de acceso:", error);
        return { valid: false };
    }
}

async function fetchUserWABAs(accessToken: string, logger: any): Promise<{ wabas?: any[]; error?: string }> {
    try {
        // ✅ CORRECCIÓN: Usar el endpoint correcto para obtener WABAs
        // Primero intentar obtener las WABAs usando el endpoint de business accounts
        logger.info("Intentando obtener WABAs del usuario...");
        
        // Método 1: Intentar desde /me/businesses (más común en tokens de usuario)
        const businessResponse = await fetch(
            `https://graph.facebook.com/v22.0/me/businesses?fields=whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        
        const businessData = await businessResponse.json() as any;
        
        if (businessResponse.ok && businessData.data) {
            // Extraer WABAs de todos los businesses
            let allWabas: any[] = [];
            businessData.data.forEach((business: any) => {
                if (business.whatsapp_business_accounts && business.whatsapp_business_accounts.data) {
                    allWabas = allWabas.concat(business.whatsapp_business_accounts.data);
                }
            });
            
            if (allWabas.length > 0) {
                logger.info(`Encontradas ${allWabas.length} WABAs desde businesses`);
                return { wabas: allWabas };
            }
        }

        // Método 2: Intentar obtener información del token para encontrar el business ID
        logger.info("Intentando obtener información del token...");
        const debugResponse = await fetch(
            `https://graph.facebook.com/v22.0/debug_token?input_token=${accessToken}&access_token=${accessToken}`
        );
        
        const debugData = await debugResponse.json() as any;
        
        if (debugResponse.ok && debugData.data) {
            logger.info("Información del token:", JSON.stringify(debugData.data, null, 2));
            
            // Si el token tiene información de business, intentar acceder directamente
            const appId = debugData.data.app_id;
            const userId = debugData.data.user_id;
            
            if (userId) {
                // Método 3: Intentar acceder a WABAs a través del user ID específico
                const userWabaResponse = await fetch(
                    `https://graph.facebook.com/v22.0/${userId}/whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}`,
                    { headers: { 'Authorization': `Bearer ${accessToken}` } }
                );
                
                const userWabaData = await userWabaResponse.json() as any;
                
                if (userWabaResponse.ok && userWabaData.data) {
                    logger.info(`Encontradas ${userWabaData.data.length} WABAs desde user ID`);
                    return { wabas: userWabaData.data };
                } else {
                    logger.warn("Error obteniendo WABAs por user ID:", userWabaData);
                }
            }
        }

        // Método 4: Probar con el endpoint directo de owned whatsapp business accounts
        logger.info("Intentando endpoint de owned WABAs...");
        const ownedResponse = await fetch(
            `https://graph.facebook.com/v22.0/me/owned_whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name,quality_rating}`,
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        
        const ownedData = await ownedResponse.json() as any;
        
        if (ownedResponse.ok && ownedData.data) {
            logger.info(`Encontradas ${ownedData.data.length} WABAs desde owned accounts`);
            return { wabas: ownedData.data };
        }

        // Si llegamos aquí, no encontramos WABAs por ningún método
        logger.error("No se pudieron obtener WABAs por ningún método. Respuestas:");
        logger.error("Business method:", JSON.stringify(businessData));
        logger.error("Owned method:", JSON.stringify(ownedData));
        
        return { 
            error: `No se encontraron WABAs. Business response: ${JSON.stringify(businessData)}, Owned response: ${JSON.stringify(ownedData)}` 
        };
        
    } catch (error) {
        logger.error("Error en fetchUserWABAs:", error);
        return { error: String(error) };
    }
}

async function checkTokenPermissions(accessToken: string, logger: any): Promise<any> {
    try {
        const response = await fetch(
            `https://graph.facebook.com/v22.0/me/permissions?access_token=${accessToken}`
        );
        
        const data = await response.json();
        
        if (response.ok) {
            return data.data || [];
        } else {
            logger.warn("Error obteniendo permisos:", data);
            return { error: data };
        }
    } catch (error) {
        logger.error("Error verificando permisos:", error);
        return { error: String(error) };
    }
}

app.http('WhatsAppIntegrationDiagnostics', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'integrations/whatsapp/diagnostics',
    handler: diagnoseWhatsAppIntegration
});