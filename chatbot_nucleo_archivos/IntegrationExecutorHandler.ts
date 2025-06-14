// src/shared/handlers/integrations/integrationExecutorHandler.ts (CORREGIDO)

import { v4 as uuidv4 } from "uuid"; // <--- CORRECCIÓN: Importar uuidv4
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES, GOOGLE_CALENDAR_CONFIG } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils"; // <-- CORRECCIÓN: Importar toAppError
import { Integration, IntegrationStatus, IntegrationAction, IntegrationType } from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";
import { UniversalValidationEngine, ValidationResult } from "../../services/universalValidationEngine";

// Importa TODOS los handlers específicos que este ejecutor podría necesitar llamar
import { GoogleCalendarHandler } from "./googleCalendarHandler";
import { WhatsAppIntegrationHandler } from "./whatsAppIntegrationHandler";
import { MicrosoftGraphHandler } from "./microsoftGraphHandler";
import { ERPConnectorHandler } from "./erpConnectorHandler";
// Asegúrate de importar cualquier otro handler de integración que implementes

export class IntegrationExecutorHandler {
  private storageService: StorageService;
  private logger: Logger;
  private validationEngine: UniversalValidationEngine;

  // Instancias de los handlers específicos para llamar a sus métodos
  private googleCalendarHandler: GoogleCalendarHandler;
  private whatsAppHandler: WhatsAppIntegrationHandler;
  private microsoftGraphHandler: MicrosoftGraphHandler;
  private erpConnectorHandler: ERPConnectorHandler;
  // Añade instancias para otros handlers si los tienes

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
    this.validationEngine = new UniversalValidationEngine(this.logger);

    // Instanciar todos los handlers específicos en el constructor
    this.googleCalendarHandler = new GoogleCalendarHandler(this.logger);
    this.whatsAppHandler = new WhatsAppIntegrationHandler(this.logger);
    this.microsoftGraphHandler = new MicrosoftGraphHandler(this.logger);
    this.erpConnectorHandler = new ERPConnectorHandler(this.logger);
    // Inicializa otros handlers aquí
  }

  /**
   * Punto de entrada principal para ejecutar una acción de integración.
   * Decide si ejecutarla síncrona o asíncronamente.
   * @param data - Los detalles de la acción a ejecutar (IntegrationAction).
   * @param requestorUserId - El ID del usuario que *inició* la solicitud.
   * @returns Resultado de la ejecución o estado 'Accepted'.
   */
  async execute(data: IntegrationAction, requestorUserId: string): Promise<any> {
    const { integrationId, action, parameters, async = false } = data;
    const endUserId = data.userId; // ID del usuario final (si se pasó)
    let integration: Integration | null = null;

    try {
      integration = await this.fetchIntegration(integrationId);
      if (!integration) {
        throw createAppError(404, `Integración no encontrada con ID: ${integrationId}`);
      }

      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
        throw createAppError(400, `La integración '${integration.name}' (ID: ${integrationId}) no está activa. Estado: ${integration.status}, isActive: ${integration.isActive}`);
      }

      if (async) {
        const queueMessage = { ...data, userIdForQueueProcessing: endUserId || requestorUserId };
        const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.INTEGRATION);
        await queueClient.sendMessage(Buffer.from(JSON.stringify(queueMessage)).toString('base64'));
        await this.logIntegrationAction(integration.agentId, integrationId, action, 'queued', endUserId || requestorUserId);
        return {
          status: 202, message: "Solicitud encolada",
          requestId: data.conversationId || data.messageId || Date.now().toString()
        };
      }

      const effectiveUserId = endUserId || requestorUserId;
      // <-- CORRECCIÓN: Pasar el objeto 'data' original a executeIntegrationAction
      const result = await this.executeIntegrationAction(integration, action, parameters, effectiveUserId, data);
      await this.logIntegrationAction(
        integration.agentId, integrationId, action,
        result.success ? 'success' : 'error', effectiveUserId,
        !result.success ? result.error : undefined
      );
      return result;

    } catch (error) {
      this.logger.error(`Error en IntegrationExecutorHandler.execute para acción '${action}' en integración ${integrationId}:`, error);
      if (integration) {
        await this.logIntegrationAction(
            integration.agentId, integrationId, action, 'error',
            endUserId || requestorUserId, error instanceof Error ? error.message : String(error)
        );
      }
      const appError = toAppError(error);
      return { success: false, error: appError.message, details: appError.details, statusCode: appError.statusCode };
    }
  }

  /**
   * Procesa un mensaje de la cola de integración (ejecución asíncrona).
   * @param message - El mensaje deserializado de la cola (debería ser tipo IntegrationAction).
   */
  async executeFromQueue(message: any): Promise<void> { // message debería ser IntegrationAction
    const { integrationId, action, parameters } = message;
    const userIdForPermCheck = message.userIdForQueueProcessing || message.userId; // El ID relevante guardado en la cola
    let integration: Integration | null = null;

    try {
        integration = await this.fetchIntegration(integrationId);
        if (!integration) {
            throw new Error(`Integración no encontrada desde cola: ${integrationId}`);
        }

        if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
            this.logger.warn(`Integración ${integrationId} no está activa, saltando ejecución desde cola.`);
            return;
        }

        // <-- CORRECCIÓN: Pasar el objeto 'message' original a executeIntegrationAction
        const result = await this.executeIntegrationAction(integration, action, parameters, userIdForPermCheck, message);

        await this.logIntegrationAction(
            integration.agentId, integrationId, action,
            result.success ? 'success' : 'error', userIdForPermCheck,
            !result.success ? result.error : undefined
        );

        if (message.callbackUrl) {
            try {
                const callbackPayload = { integrationId, action, requestId: message.conversationId || message.messageId, result };
                this.logger.info(`Enviando resultado a callback URL: ${message.callbackUrl}`);
                const response = await fetch(message.callbackUrl, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(callbackPayload)
                });
                if (!response.ok) {
                     this.logger.error(`Error en callback HTTP ${response.status} a ${message.callbackUrl}`);
                }
            } catch (callbackError) {
                this.logger.error(`Error de red al enviar resultado a callback URL ${message.callbackUrl}:`, callbackError);
            }
        }
    } catch (error) {
        this.logger.error(`Error al procesar mensaje de cola para integración ${integrationId}:`, error);
        if (integration) {
             await this.logIntegrationAction(integration.agentId, integrationId, action, 'error', userIdForPermCheck, error instanceof Error ? error.message : String(error));
        }
    }
  }


  /**
   * Delega la ejecución de la acción al handler específico basado en el tipo y proveedor.
   * @param integration - El objeto de integración completo.
   * @param action - La acción interna a realizar (ej. 'getEvents').
   * @param parameters - Los parámetros para la acción.
   * @param executingUserId - ID del usuario final o del sistema/admin que ejecuta.
   * @param originalActionData - El objeto IntegrationAction original que inició la ejecución. <-- CORRECCIÓN: Añadido parámetro
   * @returns Objeto estándar: { success: boolean, result?: any, error?: string, details?: any, statusCode?: number }
   */
private async executeIntegrationAction(
  integration: Integration,
  action: string,
  parameters: Record<string, any>,
  executingUserId: string,
  originalActionData: IntegrationAction
): Promise<{ 
  success: boolean, 
  result?: any, 
  error?: string, 
  details?: any, 
  statusCode?: number, 
  requestedSlotUnavailable?: boolean,
  validationFailed?: boolean 
}> {
  try {
    const { type, provider, id: integrationId, agentId } = integration;
    const integrationKey = `${type}:${provider}`;

    this.logger.info(`🔍 [Execute] Delegando acción '${action}' para ${integrationKey} (ID: ${integrationId})`);

    // 🔥 VALIDACIÓN UNIVERSAL ÚNICA (incluye reglas de negocio + eventId)
    const validation = await this.validationEngine.validateAction(
      agentId, 
      action, 
      parameters,
      { 
        userId: executingUserId, 
        conversationId: originalActionData.conversationId,
        integrationId: integrationId,
        // 🔑 IMPORTANTE: Pasar referencia al GoogleCalendarHandler
        googleCalendarHandler: this.googleCalendarHandler
      }
    );

    if (!validation.valid) {
      this.logger.warn(`❌ [Validation] Falló validación para '${action}': ${validation.error}`);
      return {
        success: false,
        error: validation.error,
        details: { 
          suggestion: validation.suggestion,
          validationFailure: true,
          correctedParameters: validation.correctedParameters 
        },
        statusCode: 400,
        validationFailed: true
      };
    }

    // 🔥 APLICAR CORRECCIONES AUTOMÁTICAS
    if (validation.correctedParameters) {
      this.logger.info(`🔄 [Validation] Aplicando correcciones automáticas:`, validation.correctedParameters);
      Object.assign(parameters, validation.correctedParameters);
    }

    this.logger.info(`✅ [Validation] Acción '${action}' validada correctamente`);

    // Continuar con ejecución normal...
    let response: HttpResponseInit | undefined;

    switch (integrationKey) {
      case `${IntegrationType.CALENDAR}:google`:
         response = await this.executeGoogleCalendarAction(
      action, 
      integrationId, 
      parameters, 
      executingUserId, 
      originalActionData,
      agentId  // <-- AÑADIR ESTE PARÁMETRO
    );
        break;

        case `${IntegrationType.MESSAGING}:whatsapp`:
          response = await this.executeWhatsAppAction(action, integrationId, parameters, executingUserId, originalActionData);
          break;

        case `${IntegrationType.CALENDAR}:microsoft`:
        case `${IntegrationType.EMAIL}:microsoft`:
          response = await this.executeMicrosoftAction(action, type, integrationId, parameters, executingUserId);
          break;

        case `${IntegrationType.ERP}:sap`:
        case `${IntegrationType.ERP}:dynamics`:
        case `${IntegrationType.ERP}:odoo`:
        case `${IntegrationType.ERP}:generic`:
          response = await this.executeERPAction(action, integrationId, parameters, executingUserId);
          break;

        default:
          this.logger.error(`❌ [Execute] Tipo/Proveedor no manejado: ${integrationKey}`);
          return {
            success: false,
            error: `Tipo de integración no implementado: ${integrationKey}`,
            statusCode: 501
          };
      }

      if (!response) {
        return {
          success: false,
          error: `No se pudo procesar la acción ${action} para integración ${integrationKey}`,
          statusCode: 500
        };
      }

      const status = response.status || 500;
      const body = response.jsonBody;

      if (status >= 200 && status < 300) {
  this.logger.info(`✅ [Execute] Acción '${action}' completada exitosamente (Status: ${status})`);
  return { success: true, result: body };
} else {
  this.logger.error(`❌ [Execute] Acción '${action}' falló (Status: ${status})`, body);
  const errorMessage = body?.error || body?.message || `La acción falló con estado ${status}`;
  
  // 🔥 AÑADIR: Manejo especial para errores de eliminación
  if (action === 'deleteEvent' && (status === 404 || status === 410)) {
    // Tratar 404 y 410 como éxito en eliminaciones
    this.logger.info(`✅ [Execute] Eliminación considerada exitosa - evento ya no existe (Status: ${status})`);
    return { 
      success: true, 
      result: { 
        message: "Cita eliminada exitosamente", 
        status: status === 404 ? 'not_found' : 'already_deleted' 
      }
    };
  }
  
  return { 
    success: false, 
    error: String(errorMessage), 
    details: body?.details || body?.apiError || body, 
    statusCode: status,
    requestedSlotUnavailable: body?.requestedSlotUnavailable || false
  };
}

    } catch (error) {
      this.logger.error(`💥 [Execute] Error fatal ejecutando '${action}' para integración ${integration.id}:`, error);
      const appError = toAppError(error);
      return { 
        success: false, 
        error: appError.message, 
        details: appError.details, 
        statusCode: appError.statusCode 
      };
    }
  }

private async executeGoogleCalendarAction(
  action: string, 
  integrationId: string, 
  parameters: any, 
  executingUserId: string, 
  originalActionData: IntegrationAction,
  agentId: string // <-- PARÁMETRO AÑADIDO
): Promise<HttpResponseInit> {
  
  switch (action) {
    case 'getEvents':
      return await this.googleCalendarHandler.getEvents(integrationId, executingUserId, parameters);
      
    case 'createEvent':
      if (!parameters.userEmail) {
        throw createAppError(400, "Se requiere email del usuario para crear evento");
      }
      if (!this.isValidEmail(parameters.userEmail)) {
        throw createAppError(400, `Email inválido: ${parameters.userEmail}`);
      }
      if (!parameters.userName) {
        throw createAppError(400, "Se requiere nombre del usuario para crear evento");
      }
      return await this.googleCalendarHandler.createEvent(integrationId, parameters, executingUserId);
      
    case 'updateEvent':
      if (!parameters.eventId) throw createAppError(400, "Falta eventId para updateEvent");
      const updateContextUserId = originalActionData.conversationId ? 
        await this.extractWhatsAppUserFromContext(originalActionData.conversationId, agentId) :
        executingUserId;
      return await this.googleCalendarHandler.updateEvent(integrationId, parameters.eventId, parameters, updateContextUserId);
      
case 'deleteEvent':
  if (!parameters.eventId) throw createAppError(400, "Falta eventId para deleteEvent");
  
  // 🔥 AÑADIR: Validación básica del eventId
  const eventIdToDelete = parameters.eventId.toString().trim();
  
  if (eventIdToDelete.length < 10) {
    throw createAppError(400, `EventId "${eventIdToDelete}" es demasiado corto. Los IDs reales de Google Calendar tienen más de 20 caracteres.`);
  }
  
  // Detectar IDs obviamente ficticios
  const fakeIdPatterns = [
    /^[0-9]{1,3}$/,  // "1", "10", "999"
    /^event-[0-9]{1,3}$/i,  // "event-1", "event-10"
    /^existing-event-id$/i,
    /^event-?id$/i
  ];
  
  const isFakeId = fakeIdPatterns.some(pattern => pattern.test(eventIdToDelete));
  if (isFakeId) {
    throw createAppError(400, `EventId "${eventIdToDelete}" parece ser un placeholder. Usa getMyBookedCalendarEvents para obtener el ID real.`);
  }
  
  const deleteContextUserId = originalActionData.conversationId ? 
    await this.extractWhatsAppUserFromContext(originalActionData.conversationId, agentId) :
    executingUserId;
  
  this.logger.info(`🗑️ [Execute] Ejecutando deleteEvent para evento ${eventIdToDelete} por usuario ${deleteContextUserId}`);
  
  return await this.googleCalendarHandler.deleteEvent(integrationId, eventIdToDelete, deleteContextUserId, parameters);
  
  
    case 'getMyBookedEvents':
      this.logger.info(`🔍 [Google] Ejecutando getMyBookedEvents para usuario: ${executingUserId}`);
      const response = await this.googleCalendarHandler.getMyBookedEvents(integrationId, executingUserId, parameters);
      
      // Lógica de respaldo si no encuentra eventos
      if (response?.status === 200 && response.jsonBody?.result?.events?.length === 0) {
        this.logger.warn(`⚠️ [Google] getMyBookedEvents sin resultados, intentando búsqueda manual`);
        try {
          const manualSearch = await this.googleCalendarHandler.findEventsByWhatsAppNumber(integrationId, executingUserId);
          if (manualSearch && manualSearch.length > 0) {
            this.logger.info(`✅ [Google] Búsqueda manual encontró ${manualSearch.length} eventos`);
            if (response.jsonBody && response.jsonBody.result) {
              response.jsonBody.result.events = manualSearch;
              response.jsonBody.message = `Encontré ${manualSearch.length} cita${manualSearch.length === 1 ? '' : 's'} agendada${manualSearch.length === 1 ? '' : 's'}.`;
            }
          }
        } catch (searchError) {
          this.logger.error(`❌ [Google] Error en búsqueda manual:`, searchError);
        }
      }
      
      return response;
      
    default:
      throw createAppError(400, `Acción Google Calendar no soportada: ${action}`);
  }
}

  private async executeWhatsAppAction(
    action: string, 
    integrationId: string, 
    parameters: any, 
    executingUserId: string, 
    originalActionData: IntegrationAction
  ): Promise<HttpResponseInit> {
    
    let messageType: "text" | "template" | "image" | "document" | "interactive";
    let messagePayload: any = {};

    if (action === 'sendMessage' && parameters.body) {
      messageType = 'text';
      messagePayload.text = { body: parameters.body };
    } else if (action === 'sendTemplate' && parameters.templateName && parameters.languageCode) {
      messageType = 'template';
      messagePayload.template = {
        name: parameters.templateName,
        language: { code: parameters.languageCode },
        components: parameters.componentsJson ? this.tryParseJson(parameters.componentsJson) : undefined
      };
    } else {
      throw createAppError(400, `Parámetros inválidos para WhatsApp acción: ${action}`);
    }

    const messageData = {
      integrationId: integrationId,
      to: parameters.to,
      type: messageType,
      ...messagePayload,
      internalMessageId: originalActionData.messageId
    };

    if (!messageData.to) {
      throw createAppError(400, "Falta destinatario 'to' para acción WhatsApp");
    }

    return await this.whatsAppHandler.sendMessage(messageData, executingUserId);
  }

private async executeMicrosoftAction(
  action: string, 
  type: IntegrationType, 
  integrationId: string, 
  parameters: any, 
  executingUserId: string
): Promise<HttpResponseInit> {
  
  const serviceType = type === IntegrationType.CALENDAR ? 'calendar' : 'email';
  
  switch (action) {
    case 'getEvents':
      if (serviceType !== 'calendar') throw createAppError(400, "getEvents solo para servicios de calendario");
      return await this.microsoftGraphHandler.getEvents(integrationId, executingUserId, parameters);
      
    case 'createEvent':
      if (serviceType !== 'calendar') throw createAppError(400, "createEvent solo para servicios de calendario");
      return await this.microsoftGraphHandler.createEvent(integrationId, parameters, executingUserId);
      
    case 'updateEvent':
      if (serviceType !== 'calendar') throw createAppError(400, "updateEvent solo para servicios de calendario");
      if (!parameters.eventId) throw createAppError(400, "Falta eventId para updateEvent (Microsoft)");
      return await this.microsoftGraphHandler.updateEvent(integrationId, parameters.eventId, parameters, executingUserId);
      
    case 'deleteEvent':
      if (serviceType !== 'calendar') throw createAppError(400, "deleteEvent solo para servicios de calendario");
      if (!parameters.eventId) throw createAppError(400, "Falta eventId para deleteEvent (Microsoft)");
      return await this.microsoftGraphHandler.deleteEvent(integrationId, parameters.eventId, executingUserId);
      
    case 'sendMail':
      if (serviceType !== 'email') throw createAppError(400, "sendMail solo para servicios de email");
      return await this.microsoftGraphHandler.sendMail(integrationId, parameters, executingUserId);
      
    case 'getMail':
      if (serviceType !== 'email') throw createAppError(400, "getMail solo para servicios de email");
      const mailOptions = { folder: parameters.folder || 'inbox', limit: parameters.limit || 10 };
      return await this.microsoftGraphHandler.getMail(integrationId, executingUserId, mailOptions);
      
    default:
      throw createAppError(400, `Acción Microsoft Graph (${serviceType}) no soportada: ${action}`);
  }
}

  private async executeERPAction(
    action: string, 
    integrationId: string, 
    parameters: any, 
    executingUserId: string
  ): Promise<HttpResponseInit> {
    
    switch (action) {
      case 'queryData':
        if (!parameters.entity && !parameters.query) {
          throw createAppError(400, "Falta 'entity' o 'query' para queryData ERP");
        }
        const queryOptions = { filter: parameters.filter, limit: parameters.limit || 10 };
        return await this.erpConnectorHandler.queryData(integrationId, parameters.entity || parameters.query, executingUserId, queryOptions);
        
      case 'createRecord':
        if (!parameters.entity || !parameters.data) {
          throw createAppError(400, "Falta 'entity' o 'data' para createRecord ERP");
        }
        return await this.erpConnectorHandler.createRecord(integrationId, parameters.entity, parameters.data, executingUserId);
        
      case 'updateRecord':
        if (!parameters.entity || !parameters.recordId || !parameters.data) {
          throw createAppError(400, "Falta 'entity', 'recordId' o 'data' para updateRecord ERP");
        }
        return await this.erpConnectorHandler.updateRecord(integrationId, parameters.entity, parameters.recordId, parameters.data, executingUserId);
        
      case 'deleteRecord':
        if (!parameters.entity || !parameters.recordId) {
          throw createAppError(400, "Falta 'entity' o 'recordId' para deleteRecord ERP");
        }
        return await this.erpConnectorHandler.deleteRecord(integrationId, parameters.entity, parameters.recordId, executingUserId);
        
      case 'executeQuery':
        if (!parameters.query && !parameters.sql) {
          throw createAppError(400, "Falta 'query' o 'sql' para executeQuery ERP");
        }
        return await this.erpConnectorHandler.executeQuery(integrationId, parameters, executingUserId);
        
      default:
        throw createAppError(400, `Acción ERP no soportada: ${action}`);
    }
  }


  
  // NUEVO: Extraer información de usuario de WhatsApp desde contexto de conversación
private async extractWhatsAppUserFromContext(conversationId: string, agentId: string): Promise<string> {
  try {
    const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
     const conversation = await tableClient.getEntity(agentId, conversationId); // Inspirado en cómo se obtiene en MessageReceiverHandler
    if (conversation.tempUserInfo && typeof conversation.tempUserInfo === 'string') {
      const tempInfo = JSON.parse(conversation.tempUserInfo);
      if (tempInfo.whatsappNumber) {
        return tempInfo.whatsappNumber;
      }
    }
    
    // Fallback: buscar en mensajes recientes
    const messagesTable = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
    const messages = messagesTable.listEntities({
      queryOptions: { 
        filter: `PartitionKey eq '${conversationId}'`, // Asumiendo que message metadata tiene la info
      }
    });
    
    for await (const message of messages) {
      if (message.metadata && typeof message.metadata === 'string') { // La metadata a veces es stringified
          try {
              const metadataObj = JSON.parse(message.metadata);
              if (metadataObj.whatsapp?.from) {
                this.logger.debug(`Usuario de WhatsApp extraído de metadata de mensaje: ${metadataObj.whatsapp.from}`);
                return metadataObj.whatsapp.from;
              }
          } catch (e) {
              this.logger.warn(`Error parseando metadata de mensaje en extractWhatsAppUserFromContext: ${e}`);
          }
      } else if (message.metadata && typeof message.metadata === 'object') { // A veces ya es objeto
        const metadataObj = message.metadata as any; // Cast para acceder
        if (metadataObj.whatsapp?.from) {
            this.logger.debug(`Usuario de WhatsApp extraído de metadata de mensaje (objeto): ${metadataObj.whatsapp.from}`);
            return metadataObj.whatsapp.from;
        }
      }
    }
    
    this.logger.warn(`No se pudo extraer usuario de WhatsApp del contexto para conversationId ${conversationId} y agentId ${agentId}, retornando 'unknown-whatsapp-user'`);
    return 'unknown-whatsapp-user';
  } catch (error: any) {
    if (error.statusCode === 404) {
        this.logger.warn(`Conversación ${conversationId} (agente ${agentId}) no encontrada en extractWhatsAppUserFromContext.`);
    } else {
        this.logger.error(`Error extrayendo usuario de WhatsApp del contexto (convId: ${conversationId}, agentId: ${agentId}):`, error);
    }
    return 'unknown-whatsapp-user';
  }
}

// NUEVO: Validar email
private isValidEmail(email: string): boolean {
  return GOOGLE_CALENDAR_CONFIG.EMAIL_VALIDATION_REGEX.test(email);
}
  // --- Métodos privados auxiliares ---

  /**
   * Registra la ejecución de una acción en la tabla de logs.
   */
  private async logIntegrationAction(
    agentId: string,
    integrationId: string,
    action: string,
    status: 'queued' | 'success' | 'error',
    userId: string,
    errorMessage?: string
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATION_LOGS);
      const timestamp = Date.now();
      const logEntry: any = {
        partitionKey: agentId,
        // <-- CORRECCIÓN: Usar uuidv4 importado
        rowKey: `${(9999999999999 - timestamp).toString()}_${uuidv4().substring(0, 8)}`,
        integrationId,
        action,
        status,
        executedBy: userId,
        timestamp // Usar timestamp numérico
      };
      if (status === 'error' && errorMessage) {
          logEntry.errorMessage = errorMessage.substring(0, 1024);
      }

      await tableClient.createEntity(logEntry);
    } catch (error) {
      this.logger.error(`Error al registrar acción de integración (Agent: ${agentId}, Int: ${integrationId}, Action: ${action}):`, error);
    }
  }

  /**
   * Busca una integración por su ID (RowKey) en todas las particiones.
   * Parsea la configuración JSON si existe.
   */
  private async fetchIntegration(integrationId: string): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      for await (const integration of integrations) {
        if (typeof integration.config === 'string') {
            try {
                integration.config = JSON.parse(integration.config);
            } catch (e) {
                this.logger.warn(`Error parseando config JSON para integración ${integrationId}`, e);
                integration.config = {};
            }
        } else if (integration.config === null || integration.config === undefined) {
             integration.config = {};
        }
        return integration as unknown as Integration;
      }
      this.logger.warn(`No se encontró la integración con ID: ${integrationId}`);
      return null;
    } catch (error: any) {
       if (error.statusCode !== 404) {
            this.logger.error(`Error al buscar integración ${integrationId} en Table Storage:`, error);
       }
      return null;
    }
  }

   /**
     * Intenta parsear un string JSON de forma segura.
     */
   private tryParseJson(jsonString: string | undefined | null): any | undefined {
        if (!jsonString) { return undefined; }
        try {
            return JSON.parse(jsonString);
        } catch (e) {
            this.logger.warn(`Error al parsear string JSON: "${jsonString.substring(0, 50)}..."`, e);
            return undefined;
        }
    }
}