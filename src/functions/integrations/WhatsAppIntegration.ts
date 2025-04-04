// src/functions/integrations/WhatsAppIntegration.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { WhatsAppIntegrationHandler } from "../../shared/handlers/integrations/whatsAppIntegrationHandler";
import { WhatsAppIntegrationValidator } from "../../shared/validators/integrations/whatsAppIntegrationValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function WhatsAppIntegration(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Para webhooks de WhatsApp, permitir sin autenticación
    if (request.method === 'GET' && request.url.includes('/webhook')) {
      return handleWhatsAppWebhookVerification(request, logger);
    }
    
    if (request.method === 'POST' && request.url.includes('/webhook')) {
      return handleWhatsAppWebhookMessage(request, logger);
    }
    
    // Para otras operaciones, verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" }
      };
    }
    
    // Extraer y verificar token
    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();
    
    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" }
      };
    }
    
    const userId = payload.userId;
    if (!userId) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene userId" }
      };
    }
    
    // Obtener parámetros
    const integrationId = request.params.id;
    const agentId = request.query.get('agentId');
    
    // Crear handler y validator
    const handler = new WhatsAppIntegrationHandler(logger);
    const validator = new WhatsAppIntegrationValidator(logger);
    
    // Manejar según el método HTTP
    switch (request.method) {
      case 'GET':
        if (integrationId) {
          // Obtener estado de integración de WhatsApp
          return await handler.getStatus(integrationId, userId);
        } else if (agentId) {
          // Listar números de WhatsApp para un agente
          return await handler.listNumbers(agentId, userId);
        } else {
          return {
            status: 400,
            jsonBody: { error: "Se requiere integrationId o agentId" }
          };
        }
      
      case 'POST':
        if (request.url.includes('/send')) {
          // Enviar mensaje a través de WhatsApp
          const messageData = await request.json();
          
          // Validar datos del mensaje
          const sendValidation = await validator.validateMessage(messageData, userId);
          if (!sendValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: sendValidation.errors }
            };
          }
          
          return await handler.sendMessage(messageData, userId);
        } else {
          // Configurar nueva integración de WhatsApp
          const configData = await request.json();
          
          // Validar datos de configuración
          const configValidation = await validator.validateConfig(configData, userId);
          if (!configValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: configValidation.errors }
            };
          }
          
          return await handler.setupIntegration(configData, userId);
        }
      
      case 'PUT':
        if (!integrationId) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID de la integración" }
          };
        }
        
        // Actualizar configuración de WhatsApp
        const updateData = await request.json();
        
        // Validar datos de actualización
        const updateValidation = await validator.validateConfig(updateData, userId);
        if (!updateValidation.isValid) {
          return {
            status: 400,
            jsonBody: { error: "Datos inválidos", details: updateValidation.errors }
          };
        }
        
        return await handler.updateIntegration(integrationId, updateData, userId);
      
      default:
        return {
          status: 405,
          jsonBody: { error: "Método no permitido" }
        };
    }
  } catch (error) {
    logger.error("Error en integración de WhatsApp:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

// Función para manejar verificación de webhook de WhatsApp
async function handleWhatsAppWebhookVerification(request: HttpRequest, logger: any): Promise<HttpResponseInit> {
  try {
    // Obtener parámetros de verificación de WhatsApp
    const mode = request.query.get('hub.mode');
    const token = request.query.get('hub.verify_token');
    const challenge = request.query.get('hub.challenge');
    
    logger.info(`Verificación de webhook de WhatsApp: mode=${mode}, token=${token}`);
    
    // Verificar token (debe coincidir con el configurado en Meta Business)
    const configuredToken = process.env.WHATSAPP_VERIFY_TOKEN;
    
    if (mode === 'subscribe' && token === configuredToken) {
      logger.info(`Verificación de webhook de WhatsApp exitosa`);
      return {
        status: 200,
        body: challenge
      };
    } else {
      logger.warn(`Verificación de webhook de WhatsApp fallida: token inválido`);
      return {
        status: 403,
        jsonBody: { error: "Verificación fallida" }
      };
    }
  } catch (error) {
    logger.error("Error en verificación de webhook de WhatsApp:", error);
    return {
      status: 500,
      jsonBody: { error: "Error interno en verificación de webhook" }
    };
  }
}

// Función para manejar mensajes entrantes de WhatsApp
async function handleWhatsAppWebhookMessage(request: HttpRequest, logger: any): Promise<HttpResponseInit> {
  try {
    // Obtener datos del webhook
    const webhookData = await request.json();
    
    logger.info(`Mensaje de webhook de WhatsApp recibido: ${JSON.stringify(webhookData)}`);
    
    // Crear handler
    const handler = new WhatsAppIntegrationHandler(logger);
    
    // Procesar mensaje
    await handler.processWebhook(webhookData);
    
    // WhatsApp espera una respuesta 200 OK
    return {
      status: 200,
      jsonBody: { success: true }
    };
  } catch (error) {
    logger.error("Error al procesar mensaje de WhatsApp:", error);
    
    // WhatsApp reintentará si no respondemos con 200
    return {
      status: 200,  // Respondemos 200 para evitar reintentos
      jsonBody: { success: false, error: "Error interno al procesar mensaje" }
    };
  }
}

app.http('WhatsAppIntegration', {
  methods: ['GET', 'POST', 'PUT'],
  authLevel: 'anonymous',
  route: 'integrations/whatsapp/{id?}/{action?}',
  handler: WhatsAppIntegration
});

// Endpoint específico para webhooks de WhatsApp
app.http('WhatsAppWebhook', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous', 
  route: 'integrations/whatsapp/webhook',
  handler: WhatsAppIntegration
});