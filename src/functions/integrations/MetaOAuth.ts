// src/functions/integrations/MetaOAuth.ts - CORRECCIÓN COMPLETA PARA WHATSAPP EMBEDDED SIGNUP

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createLogger, Logger } from "../../shared/utils/logger";
import { JwtService } from "../../shared/utils/jwt.service";
import { toAppError, createAppError } from "../../shared/utils/error.utils";
import { StorageService } from "../../shared/services/storage.service";
import { 
    Integration, 
    IntegrationType, 
    IntegrationStatus, 
    IntegrationWhatsAppConfig 
} from "../../shared/models/integration.model";
import { AgentHandoffConfig, HandoffMethod } from "../../shared/models/agent.model";
import { STORAGE_TABLES } from "../../shared/constants";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || `${process.env.FUNCTION_APP_URL}/api/integrations/meta/oauth/callback`;

interface MetaTokenResponse {
    access_token: string;
    token_type: string;
    expires_in?: number;
}

interface MetaLongLivedTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

// Configuración de scopes por producto Meta
function getRequiredScopes(product: string, purpose: string): string[] {
    switch(product) {
        case 'whatsapp':
            return ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'];
        case 'instagram':
            return ['instagram_messaging', 'instagram_manage_messages', 'business_management'];
        case 'facebook':
            return ['pages_messaging', 'pages_manage_metadata', 'business_management'];
        default:
            throw new Error(`Unsupported Meta product: ${product}`);
    }
}

export async function metaOAuthStart(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = createLogger(context);
    logger.info("MetaOAuthStart function processed a request.");

    try {
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
            logger.warn("Token de plataforma inválido o expirado.", error);
            return { status: 401, jsonBody: { error: "Token de plataforma inválido o expirado." } };
        }

        const platformUserId = platformUserPayload.userId;
        const agentId = request.query.get("agentId");
        const product = request.query.get("product") || "whatsapp";
        const purpose = request.query.get("purpose") || "channel";

        if (!agentId) {
            return { status: 400, jsonBody: { error: "Se requiere el parámetro 'agentId'." } };
        }

        if (!['whatsapp', 'instagram', 'facebook'].includes(product)) {
            return { status: 400, jsonBody: { error: "Producto no soportado. Use: whatsapp, instagram, facebook" } };
        }

        if (!['channel', 'handoff'].includes(purpose)) {
            return { status: 400, jsonBody: { error: "Propósito no válido. Use: channel, handoff" } };
        }

        if (!META_APP_ID || !META_REDIRECT_URI) {
            logger.error("META_APP_ID o META_REDIRECT_URI no están configurados.");
            return { status: 500, jsonBody: { error: "Configuración de OAuth de Meta incompleta en el servidor." } };
        }

        const state = Buffer.from(JSON.stringify({ 
            platformUserId, 
            agentId, 
            product, 
            purpose,
            timestamp: Date.now()
        })).toString('base64');
        
        let metaLoginUrl: string;
        
        if (product === 'whatsapp') {
            if (!process.env.META_CONFIG_ID) {
                return { status: 500, jsonBody: { error: "META_CONFIG_ID requerido para WhatsApp Embedded Signup." } };
            }
            
            // ✅ CORRECCIÓN: Usar la URL correcta para WhatsApp Embedded Signup
            const extras = encodeURIComponent(JSON.stringify({
                "setup": {},
                "featureType": "",
                "sessionInfoVersion": "3"
            }));
            
            // ✅ URL CORREGIDA: Usar app_id en lugar de client_id y la estructura correcta
            metaLoginUrl = `https://www.facebook.com/v22.0/dialog/oauth?` +
                `app_id=${META_APP_ID}&` +
                `config_id=${process.env.META_CONFIG_ID}&` +
                `extras=${extras}&` +
                `redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&` +
                `state=${state}&` +
                `response_type=code&` +
                `display=popup`;
            
            logger.info(`Usando WhatsApp Embedded Signup URL corregida - Agente: ${agentId}, Purpose: ${purpose}`);
            
        } else {
            // OAuth genérico para otros productos (Instagram, Facebook)
            const scopes = getRequiredScopes(product, purpose);
            metaLoginUrl = `https://www.facebook.com/v22.0/dialog/oauth?` +
                `client_id=${META_APP_ID}&` +
                `redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}&` +
                `state=${state}&` +
                `scope=${scopes.join(',')}&` +
                `response_type=code`;
        }
        
        logger.info(`Redirigiendo al usuario a Meta para autorización (Agent: ${agentId}, Product: ${product}, Purpose: ${purpose}).`);
        return { status: 200, jsonBody: { authorizationUrl: metaLoginUrl } };

    } catch (error) {
        logger.error("Error en MetaOAuthStart:", error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
}

export async function metaOAuthCallback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = createLogger(context);
    logger.info("MetaOAuthCallback function processed a request.");

    const storageService = new StorageService();
    let platformUserId: string | undefined;
    let agentId: string | undefined;
    let product: string | undefined;
    let purpose: string | undefined;
    let finalIntegrationId = uuidv4();

    try {
        const code = request.query.get("code");
        const stateQuery = request.query.get("state");
        const errorMeta = request.query.get("error");
        const errorDescription = request.query.get("error_description");

        if (errorMeta) {
            logger.error(`Error devuelto por Meta en callback: ${errorMeta} - ${errorDescription}`);
            return { status: 400, jsonBody: { success: false, error: `Meta OAuth Error: ${errorMeta}`, details: errorDescription } };
        }

        if (!code || !stateQuery) {
            return { status: 400, jsonBody: { success: false, error: "Faltan parámetros 'code' o 'state' en el callback de Meta." } };
        }

        let state;
        try {
            state = JSON.parse(Buffer.from(stateQuery, 'base64').toString());
            platformUserId = state.platformUserId;
            agentId = state.agentId;
            product = state.product;
            purpose = state.purpose;
        } catch (e) {
            logger.error("Error al decodificar 'state': ", e);
            return { status: 400, jsonBody: { success: false, error: "State inválido." } };
        }

        if (!platformUserId || !agentId || !product || !purpose) {
            logger.warn("State inválido o incompleto.", state);
            return { status: 400, jsonBody: { success: false, error: "State inválido o incompleto." } };
        }

        if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI) {
             logger.error("Configuración de OAuth de Meta (ID, Secret, Redirect URI) incompleta.");
             return { status: 500, jsonBody: { success: false, error: "Configuración de servidor incompleta." } };
        }

        // ✅ CORRECCIÓN: Para WhatsApp Embedded Signup, el proceso es diferente
        if (product === 'whatsapp') {
            const integrationResult = await handleWhatsAppEmbeddedSignup(
                code,
                agentId, 
                platformUserId, 
                purpose, 
                finalIntegrationId, 
                storageService, 
                logger
            );

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: `WhatsApp Embedded Signup procesado. Integración creada.`,
                    integrationId: finalIntegrationId,
                    agentId: agentId,
                    product: product,
                    purpose: purpose,
                    ...integrationResult
                }
            };
        } else {
            // Para otros productos, usar el flujo OAuth estándar
            
            // 1. Exchange code for short-lived token
            const tokenUrl = `https://graph.facebook.com/v22.0/oauth/access_token`;
            const tokenParams = new URLSearchParams({ 
                client_id: META_APP_ID, 
                redirect_uri: META_REDIRECT_URI, 
                client_secret: META_APP_SECRET, 
                code 
            });
            
            const tokenResponse = await fetch(`${tokenUrl}?${tokenParams.toString()}`);
            const shortLivedTokenData = await tokenResponse.json() as MetaTokenResponse;
            
            if (!tokenResponse.ok || !shortLivedTokenData.access_token) {
                logger.error("Error al intercambiar código por token de corta duración:", shortLivedTokenData);
                throw createAppError(tokenResponse.status, `Error de Meta al obtener token de corta duración: ${JSON.stringify(shortLivedTokenData)}`);
            }
            
            // 2. Exchange for long-lived token
            const longLivedTokenUrl = `https://graph.facebook.com/v22.0/oauth/access_token`;
            const longLivedTokenParams = new URLSearchParams({ 
                grant_type: 'fb_exchange_token', 
                client_id: META_APP_ID, 
                client_secret: META_APP_SECRET, 
                fb_exchange_token: shortLivedTokenData.access_token 
            });
            
            const longLivedTokenResponse = await fetch(`${longLivedTokenUrl}?${longLivedTokenParams.toString()}`);
            const longLivedTokenData = await longLivedTokenResponse.json() as MetaLongLivedTokenResponse;
            
            if (!longLivedTokenResponse.ok || !longLivedTokenData.access_token) {
                logger.error("Error al intercambiar por token de larga duración:", longLivedTokenData);
                throw createAppError(longLivedTokenResponse.status, `Error de Meta al obtener token de larga duración: ${JSON.stringify(longLivedTokenData)}`);
            }
            
            const clientUserAccessToken = longLivedTokenData.access_token;
            const clientUserAccessTokenExpiresAt = Date.now() + (longLivedTokenData.expires_in * 1000);
            
            logger.info(`[Agent: ${agentId}] Token de larga duración obtenido para ${product}.`);

            // 3. Manejar según producto
            let integrationResult;
            switch(product) {
                case 'instagram':
                    throw createAppError(501, "Instagram integration not implemented yet");
                case 'facebook':
                    throw createAppError(501, "Facebook integration not implemented yet");
                default:
                    throw createAppError(400, `Unsupported product: ${product}`);
            }

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: `${product} OAuth callback procesado. Integración creada.`,
                    integrationId: finalIntegrationId,
                    agentId: agentId,
                    product: product,
                    purpose: purpose,
                    ...integrationResult
                }
            };
        }

    } catch (error) {
        logger.error(`Error en MetaOAuthCallback (Agent: ${agentId || 'N/A'}, Product: ${product || 'N/A'}, Integration: ${finalIntegrationId}):`, error);
        const appError = toAppError(error);
        return { 
            status: appError.statusCode || 500, 
            jsonBody: { 
                success: false, 
                error: appError.message, 
                details: appError.details,
                agentId: agentId || 'N/A',
                product: product || 'N/A'
            } 
        };
    }
}

// ✅ FUNCIÓN CORREGIDA: Manejar específicamente WhatsApp Embedded Signup
async function handleWhatsAppEmbeddedSignup(
    code: string,
    agentId: string,
    platformUserId: string,
    purpose: string,
    finalIntegrationId: string,
    storageService: StorageService,
    logger: Logger
): Promise<any> {
    
    try {
        // ✅ Para Embedded Signup, usar el endpoint específico CON redirect_uri
        logger.info("Intercambiando código de Embedded Signup por token de acceso...");
        
        const tokenUrl = `https://graph.facebook.com/v22.0/oauth/access_token`;
        const tokenParams = new URLSearchParams({
            client_id: process.env.META_APP_ID!,
            client_secret: process.env.META_APP_SECRET!,
            code: code,
            redirect_uri: process.env.META_REDIRECT_URI! // ✅ CORRECCIÓN: SÍ incluir redirect_uri
        });
        
        const tokenResponse = await fetch(`${tokenUrl}?${tokenParams.toString()}`, {
            method: 'GET'
        });
        
        const tokenData = await tokenResponse.json() as any;
        
        if (!tokenResponse.ok || !tokenData.access_token) {
            logger.error("Error intercambiando código de Embedded Signup:", tokenData);
            throw new Error(`Failed to exchange embedded signup code: ${JSON.stringify(tokenData)}`);
        }
        
        const clientUserAccessToken = tokenData.access_token;
        const clientUserAccessTokenExpiresAt = tokenData.expires_in 
            ? Date.now() + (tokenData.expires_in * 1000) 
            : undefined;

        logger.info("Token de acceso obtenido exitosamente desde Embedded Signup");

        // ✅ Obtener información de WABA y números de teléfono
        let actualWabaId = "PENDING_FETCH";
        let actualPhoneNumberId = "PENDING_FETCH";
        let actualPhoneNumber = "Pending auto-fetch";
        let actualDisplayName = "Pending auto-fetch";
        let detailsAutoFetched = false;

        try {
            // Usar la API de Meta para obtener WABAs
            const wabaApiResponse = await fetch(
                `https://graph.facebook.com/v22.0/me/whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name}`,
                { headers: { 'Authorization': `Bearer ${clientUserAccessToken}` } }
            );
            
            const wabaApiData = await wabaApiResponse.json() as any;

            if (wabaApiResponse.ok && wabaApiData.data && wabaApiData.data.length > 0) {
                const firstWaba = wabaApiData.data[0];
                actualWabaId = firstWaba.id;
                
                if (firstWaba.phone_numbers && firstWaba.phone_numbers.data && firstWaba.phone_numbers.data.length > 0) {
                    const firstPhoneNumber = firstWaba.phone_numbers.data[0];
                    actualPhoneNumberId = firstPhoneNumber.id;
                    actualPhoneNumber = firstPhoneNumber.display_phone_number;
                    actualDisplayName = firstPhoneNumber.verified_name || `WhatsApp (${actualPhoneNumber})`;
                    detailsAutoFetched = true;
                    logger.info(`Embedded Signup - Detalles obtenidos: WABA=${actualWabaId}, Phone=${actualPhoneNumberId}`);
                }
            }
        } catch (fetchError) {
            logger.error(`Error al obtener detalles automáticamente en Embedded Signup:`, fetchError);
        }

        // ✅ Crear la integración
        const now = Date.now();
        const whatsappConfig: IntegrationWhatsAppConfig = {
            phoneNumberId: actualPhoneNumberId,
            businessAccountId: actualWabaId,
            accessToken: clientUserAccessToken,
            userAccessTokenExpiresAt: clientUserAccessTokenExpiresAt,
            phoneNumber: actualPhoneNumber,
            displayName: actualDisplayName,
            platformManaged: true,
            webhookVerifyToken: uuidv4(),
        };

        const newIntegration: Integration = {
            id: finalIntegrationId,
            agentId: agentId,
            ownerUserId: platformUserId,
            name: `WhatsApp ${purpose} - ${detailsAutoFetched ? actualDisplayName : agentId.substring(0,6)}`,
            description: `Integración WhatsApp ${purpose} via Embedded Signup`,
            type: IntegrationType.MESSAGING,
            provider: "whatsapp",
            config: JSON.stringify(whatsappConfig),
            credentials: clientUserAccessToken,
            status: detailsAutoFetched ? IntegrationStatus.ACTIVE : IntegrationStatus.CONFIGURED,
            createdBy: platformUserId,
            createdAt: now,
            isActive: true,
        };

        const integrationsTable = storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
        await integrationsTable.createEntity({
            partitionKey: agentId, 
            rowKey: finalIntegrationId,
            ...newIntegration
        });

        logger.info(`WhatsApp Embedded Signup integration ${finalIntegrationId} creada para ${purpose}`);

        // ✅ Actualizar handoff config si es necesario
        if (purpose === 'handoff') {
            try {
                const agentTable = storageService.getTableClient(STORAGE_TABLES.AGENTS);
                const agentEntity = await agentTable.getEntity('agent', agentId);

                if (agentEntity) {
                    let handoffConfig: AgentHandoffConfig = (agentEntity.handoffConfig && typeof agentEntity.handoffConfig === 'string')
                        ? JSON.parse(agentEntity.handoffConfig)
                        : { type: HandoffMethod.PLATFORM, notificationTargets: [] };
                    
                    handoffConfig.clientWhatsAppIntegrationId = finalIntegrationId;
                    if (detailsAutoFetched) {
                        handoffConfig.type = HandoffMethod.WHATSAPP;
                    }

                    await agentTable.updateEntity({
                        partitionKey: 'agent', 
                        rowKey: agentId,
                        handoffConfig: JSON.stringify(handoffConfig)
                    }, "Merge");
                    
                    logger.info(`HandoffConfig actualizado para agente ${agentId}`);
                }
            } catch (agentUpdateError) {
                logger.error(`Error actualizando handoffConfig:`, agentUpdateError);
            }
        }

        return {
            integrationStatus: newIntegration.status,
            fetchedPhoneNumberId: actualPhoneNumberId,
            fetchedWabaId: actualWabaId,
            detailsAutoFetched: detailsAutoFetched,
            embeddedSignupUsed: true
        };

    } catch (error) {
        logger.error(`Error en handleWhatsAppEmbeddedSignup:`, error);
        throw error;
    }
}

app.http('MetaOAuthStart', {
    methods: ['GET'],
    authLevel: 'anonymous', 
    route: 'integrations/meta/oauth/start',
    handler: metaOAuthStart
});

app.http('MetaOAuthCallback', {
    methods: ['GET'],
    authLevel: 'anonymous', 
    route: 'integrations/meta/oauth/callback',
    handler: metaOAuthCallback
});