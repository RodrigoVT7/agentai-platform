// src/functions/integrations/MetaOAuth.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createLogger, Logger } from "../../shared/utils/logger";
import { JwtService } from "../../shared/utils/jwt.service";
import { toAppError, createAppError } from "../../shared/utils/error.utils"; // Added createAppError
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
const META_REDIRECT_URI_WHATSAPP = process.env.META_REDIRECT_URI_WHATSAPP;
// Not strictly needed if we return JSON, but good to have defined
const FRONTEND_URL_INTEGRATIONS_BASE = `${process.env.FRONTEND_URL}/integrations/whatsapp`; 

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

interface WhatsAppPhoneNumberAPI {
    id: string;
    display_phone_number: string;
    verified_name?: string;
}

interface WhatsAppBusinessAccountAPI {
    id: string;
    name?: string;
    phone_numbers?: {
        data: WhatsAppPhoneNumberAPI[];
    };
}

interface UserWhatsAppBusinessAccountsResponseAPI {
    data: WhatsAppBusinessAccountAPI[];
    error?: any;
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
        if (!agentId) {
            return { status: 400, jsonBody: { error: "Se requiere el parámetro 'agentId'." } };
        }

        if (!META_APP_ID || !META_REDIRECT_URI_WHATSAPP) {
            logger.error("META_APP_ID o META_REDIRECT_URI_WHATSAPP no están configurados.");
            return { status: 500, jsonBody: { error: "Configuración de OAuth de Meta incompleta en el servidor." } };
        }

        const state = Buffer.from(JSON.stringify({ platformUserId, agentId, flowType: "whatsapp_account_setup" })).toString('base64');
        const scopes = ["whatsapp_business_management", "whatsapp_business_messaging", "business_management"];
        // Ensure config_id and override_default_response_type are correctly used if you are using Embedded Signup.
        // For standard OAuth, they might not be needed or override_default_response_type might be false.
        // Check Meta documentation for the specific OAuth flow you intend (standard vs. embedded signup).
        const configIdParam = process.env.META_CONFIG_ID ? `&config_id=${process.env.META_CONFIG_ID}` : '';
        const overrideParam = process.env.META_CONFIG_ID ? `&override_default_response_type=true` : ''; // Typically true for embedded signup

        const metaLoginUrl = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${META_APP_ID}&redirect_uri=${encodeURIComponent(META_REDIRECT_URI_WHATSAPP)}&state=${state}&scope=${scopes.join(',')}&response_type=code${configIdParam}${overrideParam}`;
        
        logger.info(`Redirigiendo al usuario a Meta para autorización (Agent ID: ${agentId}).`);
        return { status: 200, jsonBody: { authorizationUrl: metaLoginUrl } };

    } catch (error) {
        logger.error("Error en MetaOAuthStart:", error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
}

export async function metaOAuthCallbackWhatsAppHandoff(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const logger = createLogger(context);
    logger.info("MetaOAuthCallbackWhatsAppHandoff function processed a request.");

    const storageService = new StorageService();
    const integrationsTable = storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
    let platformUserId: string | undefined;
    let agentId: string | undefined;
    let finalIntegrationId = uuidv4(); // Pre-generate for logging

    try {
        const code = request.query.get("code");
        const stateQuery = request.query.get("state");
        const errorMeta = request.query.get("error");
        const errorDescription = request.query.get("error_description");

        if (errorMeta) {
            logger.error(`Error devuelto por Meta en callback: ${errorMeta} - ${errorDescription}`);
            // Return JSON for Postman testing instead of redirect
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
        } catch (e) {
            logger.error("Error al decodificar 'state': ", e);
            return { status: 400, jsonBody: { success: false, error: "State inválido." } };
        }

        if (!platformUserId || !agentId || state.flowType !== "whatsapp_account_setup") {
            logger.warn("State inválido o tipo de flujo incorrecto.", state);
            return { status: 400, jsonBody: { success: false, error: "State inválido o tipo de flujo incorrecto." } };
        }

        if (!META_APP_ID || !META_APP_SECRET || !META_REDIRECT_URI_WHATSAPP) {
             logger.error("Configuración de OAuth de Meta (ID, Secret, Redirect URI) incompleta.");
             return { status: 500, jsonBody: { success: false, error: "Configuración de servidor incompleta." } };
        }

        // 1. Exchange code for short-lived token
        const tokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token`;
        const tokenParams = new URLSearchParams({ client_id: META_APP_ID, redirect_uri: META_REDIRECT_URI_WHATSAPP, client_secret: META_APP_SECRET, code });
        const tokenResponse = await fetch(`${tokenUrl}?${tokenParams.toString()}`);
        const shortLivedTokenData = await tokenResponse.json() as MetaTokenResponse;
        if (!tokenResponse.ok || !shortLivedTokenData.access_token) {
            logger.error("Error al intercambiar código por token de corta duración:", shortLivedTokenData);
            throw createAppError(tokenResponse.status, `Error de Meta al obtener token de corta duración: ${JSON.stringify(shortLivedTokenData.access_token ? (shortLivedTokenData as any).error || shortLivedTokenData : shortLivedTokenData)}`);
        }
        
        // 2. Exchange for long-lived token
        const longLivedTokenUrl = `https://graph.facebook.com/v19.0/oauth/access_token`;
        const longLivedTokenParams = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: META_APP_ID, client_secret: META_APP_SECRET, fb_exchange_token: shortLivedTokenData.access_token });
        const longLivedTokenResponse = await fetch(`${longLivedTokenUrl}?${longLivedTokenParams.toString()}`);
        const longLivedTokenData = await longLivedTokenResponse.json() as MetaLongLivedTokenResponse;
        if (!longLivedTokenResponse.ok || !longLivedTokenData.access_token) {
            logger.error("Error al intercambiar por token de larga duración:", longLivedTokenData);
            throw createAppError(longLivedTokenResponse.status, `Error de Meta al obtener token de larga duración: ${JSON.stringify((longLivedTokenData as any).error || longLivedTokenData)}`);
        }
        
        const clientUserAccessToken = longLivedTokenData.access_token;
        const clientUserAccessTokenExpiresAt = Date.now() + (longLivedTokenData.expires_in * 1000);
        logger.info(`[Agent: ${agentId}] Token de larga duración obtenido.`);

        // 3. Fetch WABA and Phone Number ID using the clientUserAccessToken
        let actualWabaId = "NOT_AUTOMATICALLY_FETCHED";
        let actualPhoneNumberId = "NOT_AUTOMATICALLY_FETCHED";
        let actualPhoneNumber = "No disponible (auto-fetch)";
        let actualDisplayName = "No disponible (auto-fetch)";
        let detailsAutoFetched = false;

        try {
            logger.info(`[Agent: ${agentId}] Intentando obtener WABAs y números de teléfono del cliente...`);
            const wabaApiResponse = await fetch(
                `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name,certificate}`,
                { headers: { 'Authorization': `Bearer ${clientUserAccessToken}` } }
            );
            const wabaApiData = await wabaApiResponse.json() as UserWhatsAppBusinessAccountsResponseAPI;

            if (wabaApiResponse.ok && wabaApiData.data && wabaApiData.data.length > 0) {
                const firstWaba = wabaApiData.data[0]; // Using the first WABA
                actualWabaId = firstWaba.id;
                if (firstWaba.phone_numbers && firstWaba.phone_numbers.data && firstWaba.phone_numbers.data.length > 0) {
                    const firstPhoneNumber = firstWaba.phone_numbers.data[0]; // Using the first phone number
                    actualPhoneNumberId = firstPhoneNumber.id;
                    actualPhoneNumber = firstPhoneNumber.display_phone_number;
                    actualDisplayName = firstPhoneNumber.verified_name || `WhatsApp (${actualPhoneNumber})`;
                    detailsAutoFetched = true;
                    logger.info(`[Agent: ${agentId}] Detalles obtenidos: WABA ID=${actualWabaId}, PhoneID=${actualPhoneNumberId}, Number=${actualPhoneNumber}`);
                } else {
                    logger.warn(`[Agent: ${agentId}] WABA ${actualWabaId} no tiene números de teléfono configurados o accesibles.`);
                }
            } else {
                logger.warn(`[Agent: ${agentId}] No se encontraron WABAs o hubo un error en la API de Meta:`, wabaApiData.error || 'Respuesta vacía');
            }
        } catch (fetchDetailsError) {
            logger.error(`[Agent: ${agentId}] Error crítico al obtener detalles de WABA/Phone Number:`, fetchDetailsError);
        }

        // 4. Create and Store the Integration record
        const now = Date.now();
        const whatsappConfig: IntegrationWhatsAppConfig = {
            phoneNumberId: actualPhoneNumberId,
            businessAccountId: actualWabaId,
            accessToken: clientUserAccessToken,
            userAccessTokenExpiresAt: clientUserAccessTokenExpiresAt,
            phoneNumber: actualPhoneNumber,
            displayName: actualDisplayName,
            platformManaged: true,
        };

        const newIntegration: Integration = {
            id: finalIntegrationId,
            agentId: agentId,
            ownerUserId: platformUserId,
            name: `WhatsApp - ${detailsAutoFetched ? actualDisplayName : agentId.substring(0,6)}`,
            description: `Integración WhatsApp Business para ${detailsAutoFetched ? actualPhoneNumber : 'número pendiente'}.`,
            type: IntegrationType.MESSAGING,
            provider: "whatsapp",
            config: JSON.stringify(whatsappConfig),
            credentials: clientUserAccessToken,
            status: detailsAutoFetched && actualPhoneNumberId !== "NOT_AUTOMATICALLY_FETCHED" && actualWabaId !== "NOT_AUTOMATICALLY_FETCHED" 
                        ? IntegrationStatus.ACTIVE 
                        : IntegrationStatus.CONFIGURED, // Needs manual completion if IDs weren't fetched
            createdBy: platformUserId,
            createdAt: now,
            isActive: true,
        };

        await integrationsTable.createEntity({
            partitionKey: agentId, 
            rowKey: finalIntegrationId,
            ...newIntegration
        });
        logger.info(`[Agent: ${agentId}] Integración de WhatsApp ${finalIntegrationId} creada. Estado: ${newIntegration.status}.`);

        // 5. Update Agent's handoffConfig
        try {
            const agentTable = storageService.getTableClient(STORAGE_TABLES.AGENTS);
            const agentEntity = await agentTable.getEntity('agent', agentId); 

            if (agentEntity) {
                let handoffConfig: AgentHandoffConfig = (agentEntity.handoffConfig && typeof agentEntity.handoffConfig === 'string')
                    ? JSON.parse(agentEntity.handoffConfig)
                    : { type: HandoffMethod.PLATFORM, notificationTargets: [] };
                
                handoffConfig.clientWhatsAppIntegrationId = finalIntegrationId;
                if (detailsAutoFetched && handoffConfig.type === HandoffMethod.PLATFORM) {
                    handoffConfig.type = HandoffMethod.WHATSAPP;
                }
                if (!handoffConfig.notificationTargets) handoffConfig.notificationTargets = [];

                await agentTable.updateEntity({
                    partitionKey: 'agent', 
                    rowKey: agentId,
                    handoffConfig: JSON.stringify(handoffConfig)
                }, "Merge");
                logger.info(`[Agent: ${agentId}] HandoffConfig actualizado con clientWhatsAppIntegrationId: ${finalIntegrationId}`);
            }
        } catch (agentUpdateError) {
            logger.error(`[Agent: ${agentId}] Fallo al actualizar handoffConfig del agente:`, agentUpdateError);
        }
        
        // Return JSON response for Postman
        return { 
            status: 200, 
            jsonBody: { 
                success: true, 
                message: "OAuth callback procesado. Integración creada.",
                integrationId: finalIntegrationId,
                agentId: agentId,
                integrationStatus: newIntegration.status,
                fetchedPhoneNumberId: actualPhoneNumberId,
                fetchedWabaId: actualWabaId,
                detailsAutoFetched: detailsAutoFetched,
                configStored: whatsappConfig
            } 
        };

    } catch (error) {
        logger.error(`Error en MetaOAuthCallback (Agent: ${agentId || 'N/A'}, Integration: ${finalIntegrationId}):`, error);
        const appError = toAppError(error);
        // Return JSON for Postman
        return { 
            status: appError.statusCode || 500, 
            jsonBody: { 
                success: false, 
                error: appError.message, 
                details: appError.details,
                agentId: agentId || 'N/A' 
            } 
        };
    }
}

app.http('MetaOAuthStart', {
    methods: ['GET'],
    authLevel: 'anonymous', 
    route: 'integrations/meta/oauth/start/whatsapp-handoff',
    handler: metaOAuthStart
});

app.http('MetaOAuthCallbackWhatsAppHandoff', {
    methods: ['GET'],
    authLevel: 'anonymous', 
    route: 'integrations/meta/oauth/callback/whatsapp-handoff',
    handler: metaOAuthCallbackWhatsAppHandoff
});