// src/functions/integrations/WhatsAppChannel.ts
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { WhatsAppIntegrationHandler } from "../../shared/handlers/integrations/whatsAppIntegrationHandler";
import { WhatsAppIntegrationValidator } from "../../shared/validators/integrations/whatsAppIntegrationValidator";
import { createLogger, Logger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { StorageService } from "../../shared/services/storage.service";
import { STORAGE_TABLES } from "../../shared/constants";
import { Integration, IntegrationStatus } from "../../shared/models/integration.model";

export async function WhatsAppChannel(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // For WhatsApp webhooks, allow without authentication
    if (request.method === "GET" && request.url.includes("/webhook")) {
      return handleWhatsAppWebhookVerification(request, logger);
    }

    if (request.method === "POST" && request.url.includes("/webhook")) {
      return handleWhatsAppWebhookMessage(request, logger);
    }

    // For other operations, authentication is required
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        status: 401,
        jsonBody: { error: "Authentication required" },
      };
    }

    // Extract and verify token
    const token = authHeader.split(" ")[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Invalid or expired token" },
      };
    }

    const userId = payload.userId;
    if (!userId) {
      return {
        status: 401,
        jsonBody: { error: "Token does not contain userId" },
      };
    }

    // Get parameters from URL
    const integrationId = request.params.id;
    const agentId = request.query.get("agentId");
    const action = request.params.action;

    // Create handler and validator instances
    const handler = new WhatsAppIntegrationHandler(logger);
    const validator = new WhatsAppIntegrationValidator(logger);

    // Handle based on HTTP method and action
    switch (request.method) {
      case "GET":
        if (integrationId) {
          // Get WhatsApp integration status/details
          return await handler.getStatus(integrationId, userId);
        } else if (agentId) {
          // List WhatsApp numbers for an agent
          return await handler.listNumbers(agentId, userId);
        } else {
          return {
            status: 400,
            jsonBody: { error: "integrationId or agentId is required" },
          };
        }

      case "POST":
        // Check for 'send' action explicitly
        if (action === "send" || request.url.includes("/send")) {
          const messageDataUnknown = await request.json();
          const messageData = messageDataUnknown as any;

          // Validate message data
          const sendValidation = await validator.validateMessage(
            messageData,
            userId
          );
          if (!sendValidation.isValid) {
            return {
              status: 400,
              jsonBody: {
                error: "Invalid data",
                details: sendValidation.errors,
              },
            };
          }

          return await handler.sendMessage(messageData, userId);
        } else {
          // Default POST: Setup new WhatsApp integration (manual setup)
          const configData = await request.json();

          // Validate configuration data
          const configValidation = await validator.validateConfig(
            configData,
            userId
          );
          if (!configValidation.isValid) {
            return {
              status: 400,
              jsonBody: {
                error: "Invalid data",
                details: configValidation.errors,
              },
            };
          }

          return await handler.setupIntegration(configData, userId);
        }

      case "PUT":
        if (!integrationId) {
          return {
            status: 400,
            jsonBody: { error: "Integration ID is required" },
          };
        }

        // Update WhatsApp configuration
        const updateData = await request.json();

        // Validate update data
        const updateValidation = await validator.validateConfig(
          updateData,
          userId
        );
        if (!updateValidation.isValid) {
          return {
            status: 400,
            jsonBody: {
              error: "Invalid data",
              details: updateValidation.errors,
            },
          };
        }

        return await handler.updateIntegration(
          integrationId,
          updateData,
          userId
        );

      default:
        return {
          status: 405,
          jsonBody: { error: "Method not allowed" },
        };
    }
  } catch (error) {
    logger.error("Error in WhatsApp channel function:", error);

    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details },
    };
  }
}

/**
 * ✅ FUNCIÓN HÍBRIDA: Verifica token global (Embedded Signup) y tokens por integración (Manual)
 */
async function handleWhatsAppWebhookVerification(
  request: HttpRequest,
  logger: Logger
): Promise<HttpResponseInit> {
  try {
    const mode = request.query.get("hub.mode");
    const receivedToken = request.query.get("hub.verify_token");
    const challenge = request.query.get("hub.challenge");

    logger.info(
      `WhatsApp webhook verification received: mode=${mode}, token=${receivedToken}, challenge=${challenge}`
    );

    if (!mode || !receivedToken || !challenge) {
      logger.warn("Missing required verification parameters");
      return {
        status: 400,
        jsonBody: { error: "Missing verification parameters" },
      };
    }

    if (mode !== "subscribe") {
      logger.warn(`Invalid mode: ${mode}`);
      return {
        status: 400,
        jsonBody: { error: "Invalid mode" },
      };
    }

    // ESTRATEGIA HÍBRIDA: Verificar ambos tipos de tokens

    // 1. PRIMERO: Verificar token global de Meta (para compatibilidad con Meta Developer Console y Embedded Signup)
    const globalVerifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN;
    
    if (globalVerifyToken && receivedToken === globalVerifyToken) {
      logger.info("Webhook verification successful using GLOBAL token (Meta Developer Console/Embedded Signup)");
      return {
        status: 200,
        body: challenge,
        headers: {
          "Content-Type": "text/plain"
        }
      };
    }

    // 2. SEGUNDO: Verificar tokens específicos de integración (para configuración manual)
    const storageService = new StorageService();
    const tableClient = storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);

    logger.info(`Global token check failed. Searching for integration-specific token: ${receivedToken}`);

    // Buscar en todas las integraciones de WhatsApp activas
    const integrations = tableClient.listEntities({
      queryOptions: {
        filter: `provider eq 'whatsapp' and isActive eq true`,
      },
    });

    for await (const integration of integrations) {
      try {
        const config = typeof integration.config === "string" 
          ? JSON.parse(integration.config) 
          : integration.config;

        if (config.webhookVerifyToken === receivedToken) {
          logger.info(`Webhook verification successful using INTEGRATION token for agent: ${integration.agentId}, integration: ${integration.id}`);
          return {
            status: 200,
            body: challenge,
            headers: {
              "Content-Type": "text/plain"
            }
          };
        }
      } catch (parseError) {
        logger.warn(`Error parsing config for integration ${integration.id}:`, parseError);
        continue;
      }
    }

    // 3. Si ningún token coincide, fallar
    logger.warn(`No matching token found - Global: ${!!globalVerifyToken}, Received: ${receivedToken}`);
    return {
      status: 403,
      jsonBody: { error: "Invalid verification token" },
    };

  } catch (error) {
    logger.error("Error in WhatsApp webhook verification handler:", error);
    return {
      status: 500,
      jsonBody: { error: "Internal server error during webhook verification" },
    };
  }
}

/**
 * Handles incoming WhatsApp webhook messages (POST).
 */
async function handleWhatsAppWebhookMessage(
  request: HttpRequest,
  logger: Logger
): Promise<HttpResponseInit> {
  try {
    const webhookData = await request.json() as any;

    logger.info(
      `Incoming WhatsApp webhook message received: ${JSON.stringify(webhookData)}`
    );

    // Identificar phoneNumberId del webhook para encontrar la integración correcta
    const phoneNumberId = webhookData?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    
    if (!phoneNumberId) {
      logger.warn("No phoneNumberId found in webhook data");
      return {
        status: 200, // Siempre 200 para evitar reenvíos de Meta
        jsonBody: { success: false, error: "No phoneNumberId in webhook" },
      };
    }

    logger.info(`Processing webhook for phoneNumberId: ${phoneNumberId}`);

    const handler = new WhatsAppIntegrationHandler(logger);
    await handler.processWebhook(webhookData);

    return {
      status: 200,
      jsonBody: { success: true },
    };
  } catch (error) {
    logger.error("Error processing incoming WhatsApp message webhook:", error);

    // Siempre responder con 200 OK para evitar reenvíos repetidos de Meta
    return {
      status: 200,
      jsonBody: { success: false, error: "Internal error processing message" },
    };
  }
}

// Register the Azure Function routes for WhatsApp Channel
app.http("WhatsAppChannelWebhook", {
  methods: ["GET", "POST"],
  authLevel: "anonymous", // No authentication for webhooks
  route: "integrations/whatsapp/channel/webhook", 
  handler: WhatsAppChannel,
});

app.http("WhatsAppChannelIntegration", {
  methods: ["GET", "POST", "PUT"],
  authLevel: "anonymous", // Authentication handled manually via JWT
  route: "integrations/whatsapp/channel/{id?}/{action?}", 
  handler: WhatsAppChannel,
});