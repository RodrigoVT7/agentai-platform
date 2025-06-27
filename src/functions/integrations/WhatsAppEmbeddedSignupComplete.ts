// src/functions/integrations/WhatsAppEmbeddedSignupComplete.ts - VERSIÓN PRODUCTION

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createLogger } from "../../shared/utils/logger";
import { JwtService } from "../../shared/utils/jwt.service";
import { toAppError } from "../../shared/utils/error.utils";
import { StorageService } from "../../shared/services/storage.service";
import { STORAGE_TABLES } from "../../shared/constants";
import { 
    Integration, 
    IntegrationType, 
    IntegrationStatus, 
    IntegrationWhatsAppConfig 
} from "../../shared/models/integration.model";
import { AgentHandoffConfig, HandoffMethod } from "../../shared/models/agent.model";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

interface EmbeddedSignupCompleteRequest {
    agentId: string;
    purpose: string;
    phoneNumberId: string;
    wabaId: string;
}

interface PhoneNumberInfo {
    phoneNumber: string;
    displayName: string;
    verifiedName?: string;
    qualityRating?: string;
}

export async function completeWhatsAppEmbeddedSignup(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = createLogger(context);
    logger.info("WhatsAppEmbeddedSignupComplete function processed a request.");

    try {
        // 1. Verificar autenticación
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
        const requestData = await request.json() as EmbeddedSignupCompleteRequest;
        
        const { agentId, purpose, phoneNumberId, wabaId } = requestData;

        // 2. Validar campos requeridos
        if (!agentId || !purpose || !phoneNumberId || !wabaId) {
            return { 
                status: 400, 
                jsonBody: { 
                    error: "Todos los campos son requeridos: agentId, purpose, phoneNumberId, wabaId" 
                } 
            };
        }

        logger.info(`Iniciando creación de integración - Agent: ${agentId}, WABA: ${wabaId}, Phone: ${phoneNumberId}`);

        // 3. Preparar tokens de acceso
        const appAccessToken = `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}`;
        
        // 4. Obtener información del número de teléfono (con fallback)
        const phoneInfo = await getPhoneNumberInfoWithFallback(phoneNumberId, wabaId, appAccessToken, logger);
        
        // 5. Crear la integración
        const integrationResult = await createWhatsAppIntegration({
            phoneNumberId,
            wabaId,
            agentId,
            purpose,
            platformUserId,
            phoneInfo,
            appAccessToken
        }, logger);

        // 6. ✅ NUEVO: Configurar webhook automáticamente para canales
    let webhookResult: { webhookConfigured: boolean; error?: string } = { webhookConfigured: false };
    if (purpose === 'channel') {
        logger.info(`Configurando webhook para canal de WhatsApp...`);
        
        // Generar webhook verify token (ya lo tenemos en la función createWhatsAppIntegration)
        const webhookVerifyToken = uuidv4();
        
        webhookResult = await configureWhatsAppWebhook(
            wabaId, 
            phoneNumberId, 
            appAccessToken, 
            webhookVerifyToken,
            logger
        );
    }

    // 7. Actualizar configuración del agente si es handoff (código existente)
    if (purpose === 'handoff') {
        await updateAgentHandoffConfig(agentId, integrationResult.integrationId, logger);
    }

        logger.info(`Integración ${integrationResult.integrationId} creada exitosamente`);

         return {
        status: 201,
        jsonBody: {
            success: true,
            integrationId: integrationResult.integrationId,
            agentId: agentId,
            status: IntegrationStatus.ACTIVE,
            config: {
                phoneNumberId: phoneNumberId,
                businessAccountId: wabaId,
                phoneNumber: phoneInfo.phoneNumber,
                displayName: phoneInfo.displayName,
                verifiedName: phoneInfo.verifiedName,
                qualityRating: phoneInfo.qualityRating
            },
            webhook: {
                configured: webhookResult.webhookConfigured,
                url: purpose === 'channel' ? `${process.env.FUNCTION_APP_URL}/api/integrations/whatsapp/channel/webhook` : undefined,
                error: webhookResult.error || undefined
            },
            message: `Integración de WhatsApp creada exitosamente via Embedded Signup${purpose === 'channel' ? ' con webhook configurado' : ''}`
        }
    };
    } catch (error) {
        logger.error("Error en WhatsAppEmbeddedSignupComplete:", error);
        const appError = toAppError(error);
        return { 
            status: appError.statusCode || 500, 
            jsonBody: { 
                error: appError.message || "Error interno del servidor",
                details: appError.details 
            } 
        };
    }
}

/**
 * Obtiene información del número de teléfono con fallback a valores por defecto
 */
async function getPhoneNumberInfoWithFallback(
    phoneNumberId: string, 
    wabaId: string, 
    accessToken: string, 
    logger: any
): Promise<PhoneNumberInfo> {
    
    // Valores por defecto
    const defaultInfo: PhoneNumberInfo = {
        phoneNumber: `+${phoneNumberId.slice(-10)}`, // Últimos 10 dígitos como número
        displayName: `WhatsApp Business (${wabaId.slice(-6)})` // Últimos 6 del WABA
    };

    try {
        logger.info(`Obteniendo información del número ${phoneNumberId}...`);
        
        // Crear AbortController para timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 segundos timeout
        
        const response = await fetch(
            `https://graph.facebook.com/v22.0/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
            {
                headers: { 
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                },
                signal: controller.signal
            }
        );
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const phoneData = await response.json() as any;
            
            const info: PhoneNumberInfo = {
                phoneNumber: phoneData.display_phone_number || defaultInfo.phoneNumber,
                displayName: phoneData.verified_name || `WhatsApp (${phoneData.display_phone_number || 'Business'})`,
                verifiedName: phoneData.verified_name,
                qualityRating: phoneData.quality_rating
            };
            
            logger.info(`Información obtenida exitosamente: ${info.phoneNumber} - ${info.displayName}`);
            return info;
            
        } else {
            const errorData = await response.json().catch(() => ({}));
            logger.warn(`API de Meta respondió con error ${response.status}:`, errorData);
            logger.warn("Usando información por defecto");
            return defaultInfo;
        }
        
    } catch (error: any) {
        if (error.name === 'AbortError') {
            logger.warn("Timeout al obtener información del teléfono, usando valores por defecto");
        } else {
            logger.warn(`Error al obtener información del teléfono: ${error.message}, usando valores por defecto`);
        }
        return defaultInfo;
    }
}

/**
 * Crea la integración de WhatsApp
 */
async function createWhatsAppIntegration(params: {
    phoneNumberId: string;
    wabaId: string;
    agentId: string;
    purpose: string;
    platformUserId: string;
    phoneInfo: PhoneNumberInfo;
    appAccessToken: string;
}, logger: any): Promise<{ integrationId: string }> {
    
    const { phoneNumberId, wabaId, agentId, purpose, platformUserId, phoneInfo, appAccessToken } = params;
    
    const integrationId = uuidv4();
    const now = Date.now();

    const whatsappConfig: IntegrationWhatsAppConfig = {
        phoneNumberId: phoneNumberId,
        businessAccountId: wabaId,
        accessToken: appAccessToken,
        userAccessTokenExpiresAt: undefined, // App tokens no expiran
        phoneNumber: phoneInfo.phoneNumber,
        displayName: phoneInfo.displayName,
        platformManaged: true,
        webhookVerifyToken: uuidv4(),
    };

    const newIntegration: Integration = {
        id: integrationId,
        agentId: agentId,
        ownerUserId: platformUserId,
        name: `WhatsApp ${purpose} - ${phoneInfo.displayName}`,
        description: `Integración WhatsApp ${purpose} via Embedded Signup`,
        type: IntegrationType.MESSAGING,
        provider: "whatsapp",
        config: JSON.stringify(whatsappConfig),
        credentials: appAccessToken,
        status: IntegrationStatus.ACTIVE,
        createdBy: platformUserId,
        createdAt: now,
        updatedAt: now,
        isActive: true,
    };

    const storageService = new StorageService();
    const integrationsTable = storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
    
    await integrationsTable.createEntity({
        partitionKey: agentId, 
        rowKey: integrationId,
        ...newIntegration
    });

    logger.info(`Integración ${integrationId} guardada en storage`);
    
    return { integrationId };
}

/**
 * Actualiza la configuración de handoff del agente
 */
async function updateAgentHandoffConfig(agentId: string, integrationId: string, logger: any): Promise<void> {
    try {
        const storageService = new StorageService();
        const agentTable = storageService.getTableClient(STORAGE_TABLES.AGENTS);
        
        const agentEntity = await agentTable.getEntity('agent', agentId);

        if (agentEntity) {
            let handoffConfig: AgentHandoffConfig = { type: HandoffMethod.PLATFORM, notificationTargets: [] };
            
            if (agentEntity.handoffConfig && typeof agentEntity.handoffConfig === 'string') {
                try {
                    handoffConfig = JSON.parse(agentEntity.handoffConfig);
                } catch (parseError) {
                    logger.warn(`Error parseando handoffConfig existente, usando config por defecto:`, parseError);
                }
            }
            
            handoffConfig.clientWhatsAppIntegrationId = integrationId;
            handoffConfig.type = HandoffMethod.WHATSAPP;
            if (!handoffConfig.notificationTargets) {
                handoffConfig.notificationTargets = [];
            }

            await agentTable.updateEntity({
                partitionKey: 'agent', 
                rowKey: agentId,
                handoffConfig: JSON.stringify(handoffConfig),
                updatedAt: Date.now()
            }, "Merge");
            
            logger.info(`HandoffConfig actualizado para agente ${agentId} con integración ${integrationId}`);
        } else {
            logger.warn(`Agente ${agentId} no encontrado para actualizar handoffConfig`);
        }
    } catch (error) {
        logger.error(`Error actualizando handoffConfig para agente ${agentId}:`, error);
        // No relanzar error - la integración ya se creó exitosamente
    }
}

/**
 * Configura automáticamente el webhook de WhatsApp después del Embedded Signup
 */
async function configureWhatsAppWebhook(
    wabaId: string, 
    phoneNumberId: string, 
    accessToken: string, 
    webhookVerifyToken: string,
    logger: any
): Promise<{ webhookConfigured: boolean; error?: string }> {
    
    try {
        logger.info(`Configurando webhook para WABA ${wabaId}...`);
        
        // 1. URL del webhook (tu Azure Function)
        const webhookUrl = `${process.env.FUNCTION_APP_URL}/api/integrations/whatsapp/channel/webhook`;
        
        // 2. Configurar webhook en la WABA
        const webhookResponse = await fetch(
            `https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    subscribed_fields: ['messages', 'message_deliveries']
                })
            }
        );
        
        if (!webhookResponse.ok) {
            const errorData = await webhookResponse.json();
            logger.warn(`Error configurando webhook en WABA: ${JSON.stringify(errorData)}`);
            return { webhookConfigured: false, error: `WABA webhook error: ${JSON.stringify(errorData)}` };
        } else {
            logger.info(`Webhook configurado exitosamente en WABA ${wabaId}`);
        }
        
        // 3. También configurar a nivel de App (si tienes permisos)
        try {
            const appWebhookResponse = await fetch(
                `https://graph.facebook.com/v22.0/${process.env.META_APP_ID}/subscriptions`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        object: 'whatsapp_business_account',
                        callback_url: webhookUrl,
                        verify_token: webhookVerifyToken,
                        fields: ['messages', 'message_deliveries']
                    })
                }
            );
            
            if (appWebhookResponse.ok) {
                logger.info(`Webhook configurado a nivel de App`);
            } else {
                const appErrorData = await appWebhookResponse.json();
                logger.warn(`No se pudo configurar webhook a nivel de App: ${JSON.stringify(appErrorData)}`);
            }
        } catch (appError) {
            logger.warn(`Error configurando webhook a nivel de App:`, appError);
        }
        
        return { webhookConfigured: true };
        
    } catch (error) {
        logger.error(`Error configurando webhook:`, error);
        return { 
            webhookConfigured: false, 
            error: error instanceof Error ? error.message : String(error) 
        };
    }
}

app.http('WhatsAppEmbeddedSignupComplete', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'integrations/whatsapp/embedded-signup/complete',
    handler: completeWhatsAppEmbeddedSignup
});