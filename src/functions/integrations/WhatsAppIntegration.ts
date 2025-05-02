// src/functions/integrations/WhatsAppIntegration.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { WhatsAppIntegrationHandler } from "../../shared/handlers/integrations/whatsAppIntegrationHandler";
import { WhatsAppIntegrationValidator } from "../../shared/validators/integrations/whatsAppIntegrationValidator";
import { createLogger, Logger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { StorageService } from "../../shared/services/storage.service";
import { IntegrationWhatsAppConfig } from "../../shared/models/integration.model";
import { STORAGE_TABLES } from "../../shared/constants"

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
          const messageDataUnknown = await request.json();
          const messageData = messageDataUnknown as any;
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

/**
 * Maneja la verificación del webhook GET de WhatsApp.
 * Ahora busca el token en las configuraciones de integración almacenadas.
 */
async function handleWhatsAppWebhookVerification(request: HttpRequest, logger: Logger): Promise<HttpResponseInit> {
  try {
    // Obtener parámetros de verificación de WhatsApp
    const mode = request.query.get('hub.mode');
    const receivedToken = request.query.get('hub.verify_token'); // El token enviado por Meta
    const challenge = request.query.get('hub.challenge');

    logger.info(`Verificación de webhook de WhatsApp recibida: mode=${mode}, token=${receivedToken}`);

    if (mode === 'subscribe' && receivedToken && challenge) {
      const storageService = new StorageService();
      const tableClient = storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);

      // Buscar integraciones de WhatsApp activas
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `provider eq 'whatsapp' and isActive eq true` }
      });

      let tokenFound = false;
      for await (const integration of integrations) {
        try {
          if (integration.config && typeof integration.config === 'string') {
            const config = JSON.parse(integration.config) as IntegrationWhatsAppConfig;
            // Comparar el token recibido con el almacenado en la configuración
            if (config.webhookVerifyToken === receivedToken) {
              tokenFound = true;
              logger.info(`Token de verificación encontrado en la integración: ${integration.rowKey}`);
              break; // Salir del bucle si encontramos una coincidencia
            }
          }
        } catch (parseError) {
          logger.warn(`Error al parsear config JSON para integración ${integration.rowKey}:`, parseError);
        }
      }

      // Si encontramos una integración con el token correcto
      if (tokenFound) {
        logger.info(`Verificación de webhook de WhatsApp exitosa (token encontrado en BD)`);
        return {
          status: 200,
          body: challenge // Devolver el challenge como texto plano
        };
      } else {
        logger.warn(`Verificación de webhook de WhatsApp fallida: token "${receivedToken}" no encontrado en ninguna integración activa.`);
      }

    } else {
      logger.warn(`Solicitud de verificación de webhook inválida. Faltan parámetros.`);
    }

    // Si no se cumplen las condiciones o no se encuentra el token
    return {
      status: 403, // Forbidden
      jsonBody: { error: "Verificación fallida" }
    };

  } catch (error) {
    logger.error("Error crítico en verificación de webhook de WhatsApp:", error);
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
  route: '12',
  handler: WhatsAppIntegration
});