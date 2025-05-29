// src/shared/handlers/conversation/chatCompletionHandler.ts

import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { OpenAIService, ChatCompletionResult, OpenAITool, OpenAIToolCall } from "../../services/openai.service";
import { IntegrationExecutorHandler } from "../integrations/integrationExecutorHandler";
import { STORAGE_TABLES, AI_CONFIG, STORAGE_QUEUES, GOOGLE_CALENDAR_CONFIG } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils";
import {
    Message, MessageRole, MessageStatus, MessageType, ContextResult, IntegrationInfo
} from "../../models/conversation.model";
import { IntegrationAction, IntegrationType, IntegrationCatalogItem, CapabilityToolDefinition, IntegrationStatus } from "../../models/integration.model";
import { TableClient } from "@azure/data-tables";
import fetch from "node-fetch"; 
// Import AgentHandoffConfig
import { Agent, AgentHandoffConfig } from "../../models/agent.model"; 
import { 
  ContextAnalysis, 
  ValidationResult, 
  ValidationIssue,
  Claim 
} from "../../models/query-analysis.model";
import { TextAnalysisUtils } from "../../utils/text-analysis.utils";

interface CompletionRequest {
    messageId: string; 
    conversationId: string;
    agentId: string;
    userId: string; 
    context: ContextResult;
    assistantMessageRequestingTool?: OpenAIMessage; // Para llamadas recursivas de herramientas
}

type OpenAIMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    name?: string; 
    tool_call_id?: string; 
    tool_calls?: OpenAIToolCall[]; 
};


export class ChatCompletionHandler {
    private storageService: StorageService;
    private openaiService: OpenAIService;
    private integrationExecutor: IntegrationExecutorHandler;
    private logger: Logger;
    private catalogCache: IntegrationCatalogItem[] | null = null;
    private maxToolRecursionDepth = 3; 

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
        this.openaiService = new OpenAIService(this.logger);
        this.integrationExecutor = new IntegrationExecutorHandler(this.logger);
    }

    async execute(request: CompletionRequest): Promise<void> {
        const { messageId, conversationId, agentId, userId, context } = request;
        let assistantMessageId: string | null = null; 

        try {
            this.logger.info(`[${conversationId}] Iniciando ChatCompletion para msg ${messageId}...`);

            const agentConfig = await this.getAgentConfig(agentId);
            const availableTools = await this.getToolsForAgent(context.activeIntegrations || []);
            const { messages, latestUserQuery } = this.prepareCompletionMessages(
                context, agentConfig.systemInstructions, availableTools
            );

            if (!latestUserQuery && messages.length <= 1) { // Si solo hay mensaje de sistema
                this.logger.warn(`[${conversationId}] Sin consulta de usuario ni historial para msg ${messageId}. Abortando.`);
                return;
            }

            const startTime = Date.now();
            this.logger.info(`[${conversationId}] Llamando a OpenAI API (1ra llamada)...`);
            const completionResult: ChatCompletionResult = await this.openaiService.getChatCompletionWithTools(
                messages.filter(m => m.role !== 'tool') as { role: "system" | "user" | "assistant"; content: string | null; }[],
                availableTools,
                agentConfig.temperature ?? AI_CONFIG.TEMPERATURE,
            );
            const responseTime = Date.now() - startTime;
            this.logger.info(`[${conversationId}] Respuesta de OpenAI recibida en ${responseTime}ms.`);

            const assistantContent = completionResult.content;
            const assistantToolCalls = completionResult.toolCalls;

            // Construir el objeto de mensaje del asistente que *solicita* las herramientas (si las hay)
            const assistantMessageRequestingTools: OpenAIMessage = {
                role: "assistant",
                content: assistantContent, // Puede ser nulo si solo hay tool_calls
                ...(assistantToolCalls && assistantToolCalls.length > 0 && { tool_calls: assistantToolCalls })
            };


            if (assistantToolCalls?.length) {
                this.logger.info(`[${conversationId}] OpenAI solicitó ${assistantToolCalls.length} tool calls.`);
                await this.processToolCallsSequentially(
                    assistantToolCalls,
                    assistantMessageRequestingTools, // El mensaje del asistente que pide las herramientas
                    messages,  // El historial hasta ANTES de este mensaje del asistente
                    context,
                    agentId,
                    userId, 
                    conversationId,
                    messageId, 
                    responseTime, 
                    1 
                );
            } else if (assistantContent) {

                this.logger.info(`[${conversationId}] OpenAI generó respuesta de texto directamente.`);
                
                // Validar y mejorar la respuesta antes de guardarla
                const { validatedResponse, issues } = await this.validateAndImproveResponse(
                    assistantContent,
                    context,
                    latestUserQuery || ''
                );
                
                if (issues.length > 0) {
                    this.logger.warn(`[${conversationId}] Respuesta con ${issues.length} advertencias de validación:`, 
                    issues.map(i => `${i.type}: ${i.claim}`)
                    );
                }
                
                // Usar la respuesta validada/mejorada
                assistantMessageId = await this.saveAssistantMessage(
                    conversationId, 
                    agentId, 
                    validatedResponse, // <-- Cambiado de assistantContent a validatedResponse
                    responseTime
                );
                
                if (assistantMessageId) {
                    await this.queueForSending(conversationId, assistantMessageId, agentId, userId);
                }
                } else {
                this.logger.warn(`[${conversationId}] OpenAI respuesta vacía (sin contenido ni tool_calls) para msg ${messageId}`);
                assistantMessageId = await this.saveAssistantMessage(conversationId, agentId, "(No hubo respuesta del asistente)", responseTime, MessageStatus.FAILED);
            }

            if (completionResult.usage) {
                await this.updateUsageStats(agentId, userId, completionResult.usage.prompt_tokens, completionResult.usage.completion_tokens);
            }
            this.logger.info(`[${conversationId}] ChatCompletion para msg ${messageId} completado.`);

        } catch (error) {
            this.logger.error(`[${conversationId}] Error fatal en ChatCompletionHandler para msg ${messageId}:`, error);
            try {
                 assistantMessageId = await this.saveAssistantMessage(conversationId, agentId, "Lo siento, ocurrió un error interno al procesar tu solicitud.", 0, MessageStatus.FAILED);
                 if (assistantMessageId) { await this.queueForSending(conversationId, assistantMessageId, agentId, userId); }
            } catch (saveError){
                 this.logger.error(`[${conversationId}] Error CRÍTICO al intentar guardar/enviar mensaje de error al usuario:`, saveError);
            }
        }
    }

    private async processToolCallsSequentially(
        toolCalls: OpenAIToolCall[],
        assistantMessageRequestingTools: OpenAIMessage, // Mensaje del asistente que pidió las herramientas
        previousMessages: OpenAIMessage[], // Historial HASTA el mensaje del usuario, NO incluye assistantMessageRequestingTools
        context: ContextResult,
        agentId: string,
        endUserId: string, // El ID del usuario final con quien el bot conversa
        conversationId: string,
        originalUserMessageId: string, // ID del mensaje del usuario original que disparó esto
        responseTimeSoFar: number,
        depth: number // Para controlar la recursión
    ): Promise<void> {

        if (depth > this.maxToolRecursionDepth) {
            this.logger.error(`[${conversationId}] Profundidad máxima de llamadas a herramientas (${this.maxToolRecursionDepth}) alcanzada para msg ${originalUserMessageId}. Abortando.`);
            const errorMsgId = await this.saveAssistantMessage(conversationId, agentId, "No pude completar la acción solicitada porque es demasiado compleja y requiere demasiados pasos. Por favor, intenta simplificar tu petición.", responseTimeSoFar, MessageStatus.FAILED);
            if (errorMsgId) await this.queueForSending(conversationId, errorMsgId, agentId, endUserId);
            return;
        }

        const toolResultMessages: OpenAIMessage[] = [];
        let cumulativeResponseTime = responseTimeSoFar;
        let anyToolExecutionFailed = false; 
        let firstToolFailureMessage: string | null = null;
        let currentToolProcessingStartTime = Date.now(); 

        this.logger.info(`[${conversationId}] Procesando ${toolCalls.length} tool calls (Profundidad ${depth})...`);

        for (const toolCall of toolCalls) {
            currentToolProcessingStartTime = Date.now(); 
            const functionName = toolCall.function.name;
            let functionArgs: Record<string, any> = {};
            let executionResult: { success: boolean, result?: any, error?: string, details?: any, statusCode?: number, requestedSlotUnavailable?: boolean } | null = null;
            let toolResultMessageContent = "";

            try {
                try { functionArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { throw new Error(`Argumentos inválidos (no es JSON) para ${functionName}. Args: ${toolCall.function.arguments}`); }
                this.logger.info(`[${conversationId}] Procesando tool call (Profundidad ${depth}): ${functionName} con args:`, functionArgs);

                const actionInfo = this.mapFunctionToIntegrationAction(functionName, functionArgs, context.activeIntegrations || []);
                if (!actionInfo) { throw new Error(`No se pudo mapear '${functionName}' a una integración/acción activa.`); }

                const action: IntegrationAction = {
                    integrationId: actionInfo.integrationId,
                    action: actionInfo.action,
                    parameters: functionArgs,
                    userId: endUserId, 
                    conversationId,
                    messageId: originalUserMessageId,
                    async: false // Las herramientas se ejecutan síncronamente en este flujo
                };

                this.logger.info(`[${conversationId}] Ejecutando integración ${action.integrationId.substring(0,8)}..., acción interna: ${action.action}`);
                executionResult = await this.integrationExecutor.execute(action, endUserId); // `execute` es síncrono aquí

                // Formateo del resultado de la herramienta para el LLM
                if (executionResult?.success && executionResult.result) {
                    const baseResult = `Resultado de ${functionName}: ${JSON.stringify(executionResult.result).substring(0,1500)}`; // Truncar si es muy largo
                    if (functionName === 'createGoogleCalendarEvent') {
                        toolResultMessageContent = `ESTADO_LLAMADA_HERRAMIENTA: EXITO_EVENTO_CREADO\nID_EVENTO: ${executionResult.result.id}\nENLACE_EVENTO: ${executionResult.result.htmlLink}\nENLACE_MEET: ${executionResult.result.hangoutLink || 'N/A'}\nRESUMEN: ${executionResult.result.summary}\nINICIO: ${JSON.stringify(executionResult.result.start)}\nFIN: ${JSON.stringify(executionResult.result.end)}\nCONFERENCE_DATA: ${JSON.stringify(executionResult.result.conferenceData)}`;
                    } else {
                        toolResultMessageContent = `ESTADO_LLAMADA_HERRAMIENTA: EXITO\n${baseResult}`;
                    }
                    this.logger.info(`[${conversationId}] Ejecución ${functionName} (Profundidad ${depth}) exitosa.`);
                } else {
                    anyToolExecutionFailed = true;
                    const errorMsg = executionResult?.error || 'Error desconocido durante la ejecución de la herramienta.';
                    const statusCode = executionResult?.statusCode;
                    const requestedSlotUnavailable = executionResult?.requestedSlotUnavailable;
                    
                    if (statusCode === 409 && requestedSlotUnavailable) {
                        toolResultMessageContent = `ESTADO_LLAMADA_HERRAMIENTA: ERROR_DISPONIBILIDAD\nMENSAJE: El horario solicitado para ${functionName} ya no está disponible o hay un conflicto. Detalles: ${errorMsg}`;
                        if (!firstToolFailureMessage) firstToolFailureMessage = "Parece que el horario que seleccionaste para la cita ya no está disponible.";
                    } else {
                        toolResultMessageContent = `ESTADO_LLAMADA_HERRAMIENTA: ERROR_EJECUCION\nFUNCION: ${functionName}\nERROR: ${errorMsg}`;
                         if (!firstToolFailureMessage) firstToolFailureMessage = `Hubo un problema al intentar realizar la acción '${functionName}'.`;
                    }
                    this.logger.error(`[${conversationId}] Fallo en la ejecución de ${functionName} (Profundidad ${depth}): ${errorMsg}`, executionResult?.details);
                }

            } catch (error: any) {
                anyToolExecutionFailed = true;
                this.logger.error(`[${conversationId}] Error crítico procesando tool call ${functionName} (Profundidad ${depth}):`, error);
                toolResultMessageContent = `ESTADO_LLAMADA_HERRAMIENTA: ERROR_CRITICO\nFUNCION: ${functionName}\nERROR: ${error.message || 'Error desconocido'}`;
                if (!firstToolFailureMessage) firstToolFailureMessage = "Ocurrió un error inesperado al procesar tu solicitud.";
            } finally {
                cumulativeResponseTime += (Date.now() - currentToolProcessingStartTime); 
                toolResultMessages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: functionName,
                    content: toolResultMessageContent,
                });
            }
        } // Fin del bucle for (const toolCall of toolCalls)

        // Historial para la siguiente llamada a OpenAI:
        // 1. Mensajes originales (sistema, usuario, asistente, etc.) HASTA el mensaje del usuario actual.
        // 2. El mensaje del asistente que *solicitó* las tool_calls que acabamos de procesar.
        // 3. Los resultados de *todas* esas tool_calls.
        const messagesForNextCall: OpenAIMessage[] = [
            ...previousMessages, 
            assistantMessageRequestingTools, // El mensaje del asistente que pidió las herramientas
            ...toolResultMessages // Los resultados de esas herramientas
        ];

        this.logger.info(`[${conversationId}] Re-llamando a OpenAI (Profundidad ${depth + 1}) después de procesar ${toolCalls.length} tool calls. ¿Alguna falló?: ${anyToolExecutionFailed}`);

        const agentConfig = await this.getAgentConfig(agentId);
        const availableTools = await this.getToolsForAgent(context.activeIntegrations || []); // Podrían cambiar si una herramienta modifica el estado
        
        const nextCompletionResult = await this.openaiService.getChatCompletionWithTools(
            messagesForNextCall.filter(m => m.role !== 'tool' || (m.role === 'tool' && m.tool_call_id)) as any[], // Asegurar que los mensajes de tool tengan tool_call_id si es necesario pasarlos
            availableTools, // Pasar las herramientas disponibles de nuevo
            agentConfig.temperature ?? AI_CONFIG.TEMPERATURE,
        );
        const finalResponseTime = cumulativeResponseTime + (Date.now() - currentToolProcessingStartTime);

        const nextAssistantContent = nextCompletionResult.content;
        const nextToolCalls = nextCompletionResult.toolCalls;

        // Construir el mensaje del asistente para la siguiente ronda (si hay más tool_calls)
        const nextAssistantMessageObject: OpenAIMessage = {
            role: "assistant",
            content: nextAssistantContent,
            ...(nextToolCalls && nextToolCalls.length > 0 && { tool_calls: nextToolCalls })
        };


        if (nextToolCalls?.length) {
            this.logger.info(`[${conversationId}] OpenAI solicitó OTRA herramienta (Profundidad ${depth + 1}): ${nextToolCalls[0].function.name}`);
            await this.processToolCallsSequentially(
                nextToolCalls,
                nextAssistantMessageObject, // El mensaje del asistente que pide estas nuevas herramientas
                messagesForNextCall, // El historial completo hasta ahora
                context, agentId, endUserId, conversationId, originalUserMessageId,
                finalResponseTime, 
                depth + 1 
            );
        } else if (nextAssistantContent) {
        this.logger.info(`[${conversationId}] OpenAI generó respuesta final en texto (Profundidad ${depth + 1}).`);
        
        // Validar y mejorar la respuesta antes de guardarla
        const { validatedResponse, issues } = await this.validateAndImproveResponse(
            nextAssistantContent,
            context,
            messagesForNextCall[0]?.content || '' // Usar la query original del contexto
        );
        
        if (issues.length > 0) {
            this.logger.warn(`[${conversationId}] Respuesta con herramientas tiene ${issues.length} advertencias:`, 
            issues.map(i => `${i.type}: ${i.claim}`)
            );
        }
        
        // Usar la respuesta validada/mejorada
        const finalAssistantMessageId = await this.saveAssistantMessage(
            conversationId, 
            agentId, 
            validatedResponse, // <-- Cambiado de nextAssistantContent a validatedResponse
            finalResponseTime
        );
        
        if (finalAssistantMessageId) {
            await this.queueForSending(conversationId, finalAssistantMessageId, agentId, endUserId);
        }
        
        // Sumar tokens de esta última llamada
        if (nextCompletionResult.usage) {
            await this.updateUsageStats(agentId, endUserId, nextCompletionResult.usage.prompt_tokens, nextCompletionResult.usage.completion_tokens);
        }
        } else {
            // Si no hay contenido ni más tool_calls, y alguna herramienta falló, usar el mensaje de error de la herramienta.
            // Si no hubo fallos pero tampoco contenido, es un caso raro.
            const fallbackMsg = firstToolFailureMessage || "No pude generar una respuesta después de procesar la información. Por favor, intenta de nuevo.";
            this.logger.warn(`[${conversationId}] La llamada a OpenAI (Profundidad ${depth + 1}) no produjo contenido ni herramientas. Usando mensaje de fallback: "${fallbackMsg}"`);
            const fallbackMsgId = await this.saveAssistantMessage(conversationId, agentId, fallbackMsg, finalResponseTime, MessageStatus.FAILED);
            if (fallbackMsgId) { await this.queueForSending(conversationId, fallbackMsgId, agentId, endUserId); }
        }
    }

    private mapFunctionToIntegrationAction(
        functionName: string, args: Record<string, any>, activeIntegrations: IntegrationInfo[]
    ): { integrationId: string; action: string } | null {
         let targetIntegration: IntegrationInfo | undefined;
         let targetAction: string = '';

         const googleCalendarIntegration = activeIntegrations.find(int => int.provider === 'google' && int.type === IntegrationType.CALENDAR);
         const whatsAppIntegration = activeIntegrations.find(int => int.provider === 'whatsapp' && int.type === IntegrationType.MESSAGING);
         const microsoftIntegration = activeIntegrations.find(int => int.provider === 'microsoft'); // Podría ser CALENDAR o EMAIL
         const erpIntegration = activeIntegrations.find(int => int.type === IntegrationType.ERP);

         this.logger.debug(`Mapeando función: ${functionName}. Integraciones activas: ${activeIntegrations.map(i => `${i.name}(${i.provider}/${i.type} - ${i.id.substring(0,4)})`).join(', ')}`);

         switch (functionName) {
             // Google Calendar
             case 'createGoogleCalendarEvent': targetIntegration = googleCalendarIntegration; targetAction = 'createEvent'; break;
             case 'getGoogleCalendarEvents': targetIntegration = googleCalendarIntegration; targetAction = 'getEvents'; break;
             case 'updateGoogleCalendarEvent': targetIntegration = googleCalendarIntegration; targetAction = 'updateEvent'; break;
             case 'deleteGoogleCalendarEvent': targetIntegration = googleCalendarIntegration; targetAction = 'deleteEvent'; break;
             case 'getMyBookedCalendarEvents': targetIntegration = googleCalendarIntegration; targetAction = 'getMyBookedEvents'; break;
             
             // WhatsApp
             case 'sendWhatsAppTextMessage': targetIntegration = whatsAppIntegration; targetAction = 'sendMessage'; break; // sendMessage ahora es más genérico
             case 'sendWhatsAppTemplateMessage': targetIntegration = whatsAppIntegration; targetAction = 'sendMessage'; break; // sendMessage ahora es más genérico

             // Microsoft Graph (puede ser más específico si tienes múltiples integraciones de MS)
             case 'getMicrosoftEvents': 
                 targetIntegration = activeIntegrations.find(int => int.provider === 'microsoft' && int.type === IntegrationType.CALENDAR);
                 targetAction = 'getEvents'; 
                 break;
             case 'createMicrosoftEvent': 
                 targetIntegration = activeIntegrations.find(int => int.provider === 'microsoft' && int.type === IntegrationType.CALENDAR);
                 targetAction = 'createEvent'; 
                 break;
             case 'sendMicrosoftEmail': 
                 targetIntegration = activeIntegrations.find(int => int.provider === 'microsoft' && int.type === IntegrationType.EMAIL);
                 targetAction = 'sendMail'; 
                 break;
            
             // ERP
             case 'queryErpData': targetIntegration = erpIntegration; targetAction = 'queryData'; break;
             case 'createErpRecord': targetIntegration = erpIntegration; targetAction = 'createRecord'; break;
             
             // Handoff (si se gestiona como una herramienta)
             case 'requestHumanAgent': // Asumiendo que tienes una pseudo-integración "system" para handoff
                 targetIntegration = activeIntegrations.find(int => int.provider === 'system' && int.type === IntegrationType.SYSTEM_INTERNAL && int.id === 'SYSTEM_HANDOFF_TOOL'); // Usar el ID del catálogo
                 targetAction = 'initiateHandoff'; // La acción interna real
                 break;

             default: this.logger.warn(`Función sin mapeo definido: ${functionName}`); return null;
         }

         if (!targetIntegration) {
             this.logger.warn(`Integración necesaria para '${functionName}' no está activa o no se encontró con los criterios especificados.`);
             return null;
         }
         this.logger.debug(`Mapeado ${functionName} a ${targetIntegration.provider}/${targetIntegration.type} (ID: ${targetIntegration.id.substring(0,4)}) - Acción Interna: ${targetAction}`);
         return { integrationId: targetIntegration.id, action: targetAction };
    }

    private async getAgentConfig(agentId: string): Promise<any> {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
            const agent = await tableClient.getEntity('agent', agentId);
            let modelConfig = {};
            if (typeof agent.modelConfig === 'string' && agent.modelConfig) {
                try { modelConfig = JSON.parse(agent.modelConfig); } catch (e) { this.logger.warn(`Error parseando modelConfig: ${e}`); }
            } else if (typeof agent.modelConfig === 'object' && agent.modelConfig !== null) { modelConfig = agent.modelConfig; }
            return {
                temperature: agent.temperature as number | undefined ?? AI_CONFIG.TEMPERATURE,
                maxTokens: agent.maxTokens as number | undefined ?? AI_CONFIG.MAX_TOKENS,
                modelType: agent.modelType as string || AI_CONFIG.CHAT_MODEL,
                modelConfig: modelConfig,
                systemInstructions: agent.systemInstructions as string || ''
            };
        } catch (error) {
            this.logger.error(`Error al obtener config agente ${agentId}. Usando defaults.`, error);
            return { temperature: AI_CONFIG.TEMPERATURE, maxTokens: AI_CONFIG.MAX_TOKENS, modelType: AI_CONFIG.CHAT_MODEL, systemInstructions: '' };
        }
    }

    private async getToolsForAgent(activeIntegrations: IntegrationInfo[]): Promise<OpenAITool[]> {
        const tools: OpenAITool[] = [];
        if (!activeIntegrations?.length) {
            this.logger.debug("No hay integraciones activas, no se generarán herramientas.");
            return tools;
        }
        try {
            if (!this.catalogCache) {
                this.catalogCache = await this.loadIntegrationCatalog();
            }
            if (!this.catalogCache) {
                this.logger.error("No se pudo cargar el catálogo de integraciones.");
                return tools;
            }

            this.logger.debug(`Buscando herramientas para ${activeIntegrations.length} integraciones activas: ${activeIntegrations.map(i => i.id.substring(0,4)).join(', ')}`);

            for (const catalogItem of this.catalogCache) {
                 // Una integración está "activa para herramientas" si su ID del catálogo está presente en activeIntegrations
                 // O si su tipo y proveedor coinciden con alguna integración activa (para casos más genéricos)
                 const isToolSourceActive = activeIntegrations.some(activeInt => 
                     activeInt.id === catalogItem.id || // El ID de la integración activa coincide con el ID del catálogo
                     (activeInt.provider === catalogItem.provider && activeInt.type === catalogItem.type) // Coincidencia genérica por tipo/proveedor
                 );


                if (isToolSourceActive) {
                    this.logger.debug(`Procesando catálogo activo: ${catalogItem.name} (Tipo: ${catalogItem.type}, Provider: ${catalogItem.provider}, ID Catálogo: ${catalogItem.id})`);
                    if (catalogItem.capabilityTools?.length) {
                        for (const toolDef of catalogItem.capabilityTools) {
                            if (toolDef?.toolName && toolDef.description && toolDef.parametersSchema && toolDef.parametersSchema.type === 'object') {
                                const tool: OpenAITool = {
                                     type: "function",
                                     function: {
                                         name: toolDef.toolName,
                                         description: toolDef.description,
                                         parameters: toolDef.parametersSchema
                                     }
                                 };
                                tools.push(tool);
                                this.logger.debug(` -> Herramienta añadida: ${toolDef.toolName}`);
                            } else {
                                this.logger.warn(`Definición de herramienta inválida o incompleta en catálogo ${catalogItem.name}:`, toolDef);
                            }
                        }
                    } else {
                         this.logger.debug(` -> Sin herramientas definidas en catálogo para ${catalogItem.name}`);
                    }
                }
            }
        } catch (error) {
            this.logger.error("Error construyendo herramientas desde el catálogo:", error);
        }
        this.logger.info(`Herramientas generadas para OpenAI: ${tools.length} (${tools.map(t => t.function.name).join(', ') || 'Ninguna'})`);
        return tools;
    }

    private async loadIntegrationCatalog(): Promise<IntegrationCatalogItem[] | null> {
         if (this.catalogCache) {
             this.logger.debug("Devolviendo catálogo de integraciones cacheado.");
             return this.catalogCache;
         }
         this.logger.info("Cargando catálogo de integraciones desde Table Storage...");
         try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATION_CATALOG);
            const items: IntegrationCatalogItem[] = [];
            const entities = tableClient.listEntities();
            for await (const entity of entities) {
                try {
                    let capabilityTools: CapabilityToolDefinition[] = [];
                    if (typeof entity.capabilityTools === 'string') {
                        try { capabilityTools = JSON.parse(entity.capabilityTools); } catch { capabilityTools = []; }
                    } else if (Array.isArray(entity.capabilityTools)) { capabilityTools = entity.capabilityTools; }

                    let configSchema: Record<string, any> = {};
                     if (typeof entity.configSchema === 'string') {
                         try { configSchema = JSON.parse(entity.configSchema); } catch { configSchema = {}; }
                     } else if (typeof entity.configSchema === 'object' && entity.configSchema !== null) { configSchema = entity.configSchema; }

                    if (typeof entity.rowKey === 'string' && typeof entity.name === 'string' && typeof entity.description === 'string' &&
                        typeof entity.type === 'string' && typeof entity.provider === 'string' && typeof entity.icon === 'string' &&
                        typeof entity.requiresAuth === 'boolean' && typeof entity.setupGuide === 'string') {

                        items.push({
                            id: entity.rowKey, // ID del catálogo es el RowKey
                            name: entity.name,
                            description: entity.description,
                            type: entity.type as IntegrationType,
                            provider: entity.provider,
                            icon: entity.icon,
                            capabilityTools: capabilityTools,
                            requiresAuth: entity.requiresAuth,
                            setupGuide: entity.setupGuide,
                            configSchema: configSchema
                        });
                    } else {
                         this.logger.warn(`Item de catálogo ${entity.rowKey} tiene tipos de datos inválidos, omitiendo.`);
                    }
                } catch (parseError) {
                    this.logger.warn(`Error parseando item catálogo ${entity.rowKey}:`, parseError);
                }
            }
            this.logger.info(`Catálogo de integraciones cargado con ${items.length} items.`);
            this.catalogCache = items;
            return items;
         } catch (error) {
             this.logger.error("Error fatal cargando catálogo de integraciones:", error);
             return null;
         }
    }

    // Reemplazar el método prepareCompletionMessages con:
private prepareCompletionMessages(
  context: ContextResult, 
  systemInstructionsBase: string, 
  availableTools: OpenAITool[]
): { messages: OpenAIMessage[], latestUserQuery: string | null } {
  
  const MAX_RECENT_MESSAGES = 10;
  const { recentValidMessages, latestUserMessage } = this.getRecentValidMessages(
    context.conversationContext, 
    MAX_RECENT_MESSAGES
  );
  const latestUserQuery = latestUserMessage ? latestUserMessage.content : null;
  
  // Analizar el contexto recuperado
  const contextAnalysis = this.analyzeRetrievedContext(context);
  
  // Generar instrucciones dinámicas basadas en el análisis
  const dynamicInstructions = this.generateDynamicInstructions(contextAnalysis, latestUserQuery);
  
  // Construir mensaje del sistema
  let systemContent = systemInstructionsBase || "Eres un asistente útil.";
  
  // Añadir información temporal
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    const currentDateTime = now.toLocaleString('es-MX', { 
      timeZone, 
      dateStyle: 'full', 
      timeStyle: 'long' 
    });
    systemContent += `\n\nFecha y Hora Actual: ${currentDateTime} (${timeZone}).`;
  } catch (e) {
    systemContent += `\n\nFecha y Hora Actual: ${now.toISOString()}.`;
  }
  
  // Añadir instrucciones dinámicas si hay
  if (dynamicInstructions) {
    systemContent += `\n\n### Instrucciones Contextuales Dinámicas:\n${dynamicInstructions}\n`;
  }
  
  // Añadir instrucciones sobre herramientas
  if (availableTools.length > 0) {
    systemContent += "\n\n### Herramientas Disponibles:\n";
    systemContent += this.generateToolInstructions(availableTools);
  }
  
  // Añadir información relevante del contexto
  if (context.relevantChunks?.length > 0) {
    systemContent += "\n\n### Información de tu Base de Conocimiento:\n";
    systemContent += this.formatRelevantChunks(context.relevantChunks, contextAnalysis);
  }
  
  // Construir array de mensajes
  const messages: OpenAIMessage[] = [];
  messages.push({ role: 'system', content: systemContent });
  
  // Añadir mensajes de la conversación
  messages.push(...recentValidMessages.map(msg => ({
    role: this.mapRoleToOpenAI(msg.role),
    content: msg.content ?? null,
    ...(msg as any).tool_calls && { tool_calls: (msg as any).tool_calls }
  })));
  
  this.logger.debug(`Mensajes preparados: ${messages.length} (sistema + ${recentValidMessages.length} conversación)`);
  
  this.logger.debug(`[prepareCompletionMessages] Prompt de Sistema Final para LLM:\n${messages.find(m => m.role === 'system')?.content}`);
this.logger.debug(`[prepareCompletionMessages] Historial de Conversación para LLM (${recentValidMessages.length} mensajes):`);
recentValidMessages.forEach(msg => {
    this.logger.debug(`  - Rol: ${msg.role}, Contenido: ${(msg.content || "").substring(0, 100)}...`);
});

return { messages, latestUserQuery };
}

// Añadir estos nuevos métodos:

private analyzeRetrievedContext(context: ContextResult): ContextAnalysis {
  const analysis: ContextAnalysis = {
    hasStructuredData: false,
    dataTypes: [],
    requiresComparison: false,
    hasNumericContent: false,
    contentPatterns: [],
    dominantLanguage: 'es'
  };
  
  if (!context.relevantChunks?.length) return analysis;
  
  const allContent = context.relevantChunks.map(chunk => chunk.content).join('\n');
  
  // Detectar idioma dominante
  analysis.dominantLanguage = TextAnalysisUtils.detectLanguage(allContent);
  
  // Analizar cada chunk
  context.relevantChunks.forEach(chunk => {
    const chunkAnalysis = this.analyzeChunkContent(chunk.content);
    
    analysis.hasStructuredData = analysis.hasStructuredData || chunkAnalysis.isStructured;
    analysis.hasNumericContent = analysis.hasNumericContent || chunkAnalysis.hasNumbers;
    
    if (chunkAnalysis.detectedTypes.length > 0) {
      analysis.dataTypes.push(...chunkAnalysis.detectedTypes);
    }
    
    if (chunkAnalysis.patterns.length > 0) {
      analysis.contentPatterns.push(...chunkAnalysis.patterns);
    }
  });
  
  // Deduplicar y limpiar
  analysis.dataTypes = [...new Set(analysis.dataTypes)];
  analysis.contentPatterns = [...new Set(analysis.contentPatterns)];
  
  // Detectar si el contexto sugiere comparaciones
  analysis.requiresComparison = analysis.contentPatterns.includes('multiple-items') || 
                                analysis.contentPatterns.includes('comparative-data');
  
  return analysis;
}

private analyzeChunkContent(content: string): any {
  const analysis = {
    isStructured: false,
    hasNumbers: false,
    detectedTypes: [] as string[],
    patterns: [] as string[]
  };
  
  // Detectar números
  const numbers = TextAnalysisUtils.extractNumbers(content);
  analysis.hasNumbers = numbers.length > 0;
  
  // Detectar estructura
  const lines = content.split('\n').filter(l => l.trim());
  const lineFormats = lines.map(line => TextAnalysisUtils.getLineFormat(line));
  
  // Verificar si es estructurado
  const structuredLines = lineFormats.filter(f => f.hasSeparator || f.isHeader).length;
  analysis.isStructured = structuredLines > lines.length * 0.4;
  
  // Detectar tipos de datos
  if (lineFormats.some(f => f.hasSeparator && f.columnCount > 2)) {
    analysis.detectedTypes.push('table');
  }
  
  if (lines.filter(l => /^[\s\-\*\d]+\.?\s/.test(l)).length > lines.length * 0.3) {
    analysis.detectedTypes.push('list');
  }
  
  if (lines.filter(l => TextAnalysisUtils.looksLikeKey(l)).length > lines.length * 0.3) {
    analysis.detectedTypes.push('key-value');
  }
  
  // Detectar patrones de contenido
  if (numbers.length > 5) {
    analysis.patterns.push('numeric-heavy');
  }
  
  // Detectar si hay múltiples items del mismo tipo
  const linePatterns = new Map<string, number>();
  lines.forEach(line => {
    const pattern = this.getSimplifiedLinePattern(line);
    if (pattern) {
      linePatterns.set(pattern, (linePatterns.get(pattern) || 0) + 1);
    }
  });
  
  const repeatedPatterns = Array.from(linePatterns.values()).filter(count => count > 2);
  if (repeatedPatterns.length > 0) {
    analysis.patterns.push('multiple-items');
  }
  
  // Detectar contenido comparativo
  const comparativeKeywords = /comparar|versus|diferencia|ventaja|desventaja/i;
  if (comparativeKeywords.test(content)) {
    analysis.patterns.push('comparative-data');
  }
  
  return analysis;
}

private getSimplifiedLinePattern(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 10) return null;
  
  return trimmed
    .replace(/\d+([.,]\d+)?/g, 'N')
    .replace(/\$\s*N/g, '$N')
    .replace(/"[^"]+"/g, 'S')
    .replace(/\b[A-Z][a-z]+\b/g, 'W');
}

// ACTUALIZAR en chatCompletionHandler.ts
// Método generateDynamicInstructions - AGREGAR LÓGICA DE COMPARACIÓN

private generateDynamicInstructions(
  contextAnalysis: ContextAnalysis, 
  userQuery: string | null
): string {
  const instructions: string[] = [];
  
  // Instrucciones basadas en el tipo de datos en el contexto
  if (contextAnalysis.hasStructuredData) {
    instructions.push(
      "He detectado que la información recuperada contiene datos estructurados. " +
      "Analiza cuidadosamente la estructura y las relaciones entre los datos antes de responder."
    );
  }
  
  if (contextAnalysis.hasNumericContent) {
    instructions.push(
      "La información contiene valores numéricos. Al trabajar con estos números:\n" +
      "- NO inventes ni modifiques ningún valor numérico\n" +
      "- Identifica claramente las unidades y contexto de cada número\n" +
      "- Si realizas cálculos o comparaciones, muestra tu proceso paso a paso\n" +
      "- Incluye los valores originales en tu respuesta"
    );
  }
  
  // **NUEVA LÓGICA ESPECÍFICA PARA CONSULTAS COMPARATIVAS**
  if (userQuery) {

   const queryLower = userQuery.toLowerCase();

    // Palabras clave generales para identificar la solicitud de un listado completo
    const generalListingKeywords = /\b(todos|toda la lista|lista de todos|lista completa|listado de todos|ver todos|mostrar todos|catalogo completo|inventario completo|cuales son todas las opciones|muestrame los disponibles)\b/i;
    const isGeneralListingQuery = generalListingKeywords.test(queryLower);

    // Palabras clave generales que sugieren encontrar un extremo, ranking o una cualidad específica
    const generalExtremesOrQualityKeywords = /\b(más|menos|mayor|menor|máximo|mínimo|mejor|peor|principal|top|bottom|barato|caro|económico|costoso|grande|pequeño|nuevo|viejo|reciente|antiguo|alto|bajo|temprano|tard[ií]o)\b/i;
    const hasGeneralExtremesOrQualityKeywords = generalExtremesOrQualityKeywords.test(queryLower);

    // Palabras clave que indican una solicitud explícita de *solo* el extremo.
    const onlyExtremesKeywords = /\b(solo el|solamente el|unicamente el|dime el|cual es el|identifica el)\s+(más|menos|mayor|menor|máximo|mínimo|mejor|peor|barato|caro|económico|costoso|grande|pequeño|nuevo|viejo|reciente|antiguo|alto|bajo|temprano|tard[ií]o)\b/i;
    const isOnlyExtremesQuery = onlyExtremesKeywords.test(queryLower);


    
    if (contextAnalysis.hasNumericContent || contextAnalysis.contentPatterns.includes('multiple-items') || contextAnalysis.dataTypes.includes('table') || contextAnalysis.dataTypes.includes('list')) {
        
        if (isGeneralListingQuery) {
            instructions.push(
                "⚠️ CONSULTA DE LISTADO COMPLETO DETECTADA ⚠️\n" +
                "El usuario desea ver TODAS las opciones/ítems relevantes disponibles en la información recuperada que correspondan a su consulta.\n" +
                "PROCESO OBLIGATORIO:\n" +
                "1. Examina CUIDADOSAMENTE toda la información proporcionada en el contexto que sea pertinente a la pregunta del usuario.\n" +
                "2. IDENTIFICA y EXTRAE TODAS las unidades/opciones/ítems individuales con sus detalles relevantes (ej. descripciones, valores, características) que respondan a la consulta.\n" +
                "3. Si el usuario especificó un criterio de ORDEN (ej. 'del más barato al más caro', 'por fecha', 'alfabéticamente'), PRESENTA LA LISTA COMPLETA siguiendo estrictamente ese orden.\n" +
                "4. Si no se especificó un orden explícito, pero la información recuperada ya sugiere uno (ej. una tabla ya ordenada, una lista de precios pre-ordenada en el contexto), considera presentarlo así, indicando el orden si es relevante.\n" +
                "5. Asegúrate de incluir TODAS las opciones que encuentres en la información recuperada que sean pertinentes a la consulta. No omitas ninguna. El objetivo es ser exhaustivo.\n" +
                "6. NO RESUMAS la lista a solo los valores extremos (ej. mínimo y máximo) o un rango general, A MENOS QUE el usuario pida explícitamente SOLO eso (ej. 'dime solo el más bajo y el más alto', 'cuál es el rango de precios').\n" +
                "\n**CRÍTICO**: La meta es mostrar TODAS las opciones relevantes para la consulta del usuario. Si la información recuperada está claramente estructurada como una lista o tabla completa y es pertinente, esa es tu fuente principal y debes considerar presentarla íntegramente o en su totalidad si así se solicita."
            );
            // Si además de "todos" se mencionan palabras de ordenamiento/extremos, interpretar como criterio de orden para la lista completa.
            if (hasGeneralExtremesOrQualityKeywords && !isOnlyExtremesQuery) {
                 instructions.push(
                    "NOTA ADICIONAL: El usuario también mencionó un criterio que podría implicar orden (ej. 'barato', 'grande', 'nuevo'). Utiliza esto como guía para ORDENAR la lista completa que presentes, si corresponde y es solicitado."
                 );
            }
        } else if (hasGeneralExtremesOrQualityKeywords) { // El usuario preguntó por algo que implica un extremo/calidad, pero no necesariamente un listado completo.
            instructions.push(
                "⚠️ CONSULTA DE IDENTIFICACIÓN DE EXTREMO/CALIDAD ESPECÍFICA DETECTADA ⚠️\n" +
                "El usuario parece estar buscando un ítem/valor que representa un extremo (ej. el más económico, el más grande) o un subconjunto específico basado en una cualidad o comparación.\n" +
                "PROCESO OBLIGATORIO:\n" +
                "1. IDENTIFICA TODOS los ítems comparables en la información que se relacionen directamente con la pregunta del usuario.\n" +
                "2. EXTRAE los valores o características relevantes para la comparación (ej. precios, tamaños, fechas, calificaciones).\n" +
                "3. COMPARA sistemáticamente estos valores/características para encontrar el/los que cumplen la condición específica del usuario (ej. el valor más bajo para 'barato', el valor más alto para 'caro', los que cumplen una condición 'X').\n" +
                "4. Responde CLARAMENTE con el/los ítem(s) y su(s) valor(es) que cumplen con ser el extremo o la selección solicitada. Generalmente, será una o un número reducido de opciones que respondan directamente a la pregunta.\n" +
                "5. NO listes todos los ítems disponibles A MENOS QUE se te haya pedido explícitamente con términos como 'todos', 'lista completa', etc.\n" +
                "\n**CRÍTICO**: Verifica cuidadosamente que has comparado todos los ítems relevantes antes de declarar un extremo o selección. Si la pregunta es abierta sobre una cualidad (ej. '¿qué opciones económicas tienes?'), puedes presentar algunas opciones que cumplan, pero no necesariamente la lista entera, a menos que el contexto y la pregunta así lo sugieran."
            );
        }
    }
    
    // Instrucciones específicas por tipo de comparación
    if (/\b(más\s+barato|menos\s+caro|más\s+económico|mínimo|menor\s+precio)\b/.test(queryLower)) {
      instructions.push(
        "🔍 BÚSQUEDA DEL VALOR MÍNIMO:\n" +
        "- Busca TODOS los precios/valores en la información\n" +
        "- Identifica el MENOR número\n" +
        "- Ese es el más barato/económico\n"
      );
    }
    
    if (/\b(más\s+caro|menos\s+barato|más\s+costoso|máximo|mayor\s+precio)\b/.test(queryLower)) {
      instructions.push(
        "🔍 BÚSQUEDA DEL VALOR MÁXIMO:\n" +
        "- Busca TODOS los precios/valores en la información\n" +
        "- Identifica el MAYOR número\n" +
        "- Ese es el más caro/costoso"
      );
    }
  }
  
  // Resto de instrucciones existentes...
  if (contextAnalysis.dataTypes.includes('table')) {
    instructions.push(
      "Los datos están organizados en formato tabular. " +
      "Identifica las columnas/campos y sus relaciones. " +
      "Si necesitas comparar filas, hazlo sistemáticamente comparando CADA fila."
    );
  }
  
  if (contextAnalysis.dataTypes.includes('list')) {
    instructions.push(
      "La información está organizada como lista. " +
      "Respeta el orden y la estructura al analizar los elementos. " +
      "Para comparaciones, revisa CADA elemento de la lista."
    );
  }
  
  // Instrucciones basadas en patrones detectados
  if (contextAnalysis.contentPatterns.includes('multiple-items')) {
    instructions.push(
      "He detectado múltiples elementos similares en la información. " +
      "Si necesitas hacer comparaciones o selecciones:\n" +
      "1. Lista TODOS los elementos relevantes primero\n" +
      "2. Identifica los criterios de comparación\n" +
      "3. Realiza la comparación paso a paso\n" +
      "4. Presenta tu conclusión con los datos específicos"
    );
  }
  
  // Instrucción final sobre validación (REFORZADA PARA COMPARACIONES)
  if (contextAnalysis.hasNumericContent || contextAnalysis.contentPatterns.includes('multiple-items')) {
    instructions.push(
      "\n🚨 VALIDACIÓN FINAL OBLIGATORIA:\n" +
      "Antes de dar tu respuesta final, verifica mentalmente que:\n" +
      "- Has considerado TODOS los valores/opciones disponibles\n" +
      "- Tu respuesta corresponde al valor correcto (mínimo para 'barato', máximo para 'caro')\n" +
      "- Los números mencionados existen en la información proporcionada\n" +
      "- No has inventado ni modificado ningún dato\n" +
      "- Has seguido el proceso de comparación completo"
    );
  }
  
  return instructions.join('\n\n');
}

private getLanguageName(code: string): string {
 const languages: Record<string, string> = {
   'es': 'español',
   'en': 'inglés',
   'pt': 'portugués',
   'fr': 'francés',
   'de': 'alemán',
   'it': 'italiano'
 };
 return languages[code] || code;
}

private generateToolInstructions(tools: OpenAITool[]): string {
 let instructions = "Puedes usar las siguientes herramientas cuando sea necesario:\n\n";
 
 tools.forEach(tool => {
   instructions += `- **${tool.function.name}**: ${tool.function.description}\n`;
 });
 
 instructions += "\n";
 instructions += "Cuando uses herramientas:\n";
 instructions += "1. Solo úsalas si es necesario para cumplir con la solicitud del usuario\n";
 instructions += "2. Asegúrate de tener toda la información requerida antes de llamar a una herramienta\n";
 instructions += "3. Si falta información, pregunta al usuario primero\n";
 
 return instructions;
}

private formatRelevantChunks(
 chunks: Array<{ content: string; documentId: string; chunkId: string; similarity: number }>,
 analysis: ContextAnalysis
): string {
 let formatted = "Esta información proviene de tus documentos. ";
 
 if (analysis.hasStructuredData || analysis.hasNumericContent) {
   formatted += "**IMPORTANTE**: Analiza cuidadosamente la estructura y los valores antes de responder.\n\n";
 } else {
   formatted += "Úsala para formular tu respuesta.\n\n";
 }
 
 chunks.forEach((chunk, index) => {
   formatted += `--- Fragmento ${index + 1} ---\n`;
   formatted += `Relevancia: ${(chunk.similarity * 100).toFixed(0)}%\n`;
   formatted += `Contenido:\n${chunk.content}\n`;
   formatted += `--- Fin Fragmento ${index + 1} ---\n\n`;
 });
 
 return formatted;
}

// Añadir método de validación de respuesta después de generar
private async validateAndImproveResponse(
 response: string,
 context: ContextResult,
 query: string
): Promise<{ validatedResponse: string; issues: ValidationIssue[] }> {
 const validation = await this.validateResponse(response, context, query);
 
 if (validation.isValid) {
   return { validatedResponse: response, issues: [] };
 }
 
 // Si hay problemas, intentar mejorar la respuesta
 this.logger.warn(`Respuesta con ${validation.issues.length} problemas de validación`);
 
 // Crear un prompt de corrección
 const correctionPrompt = this.createCorrectionPrompt(response, validation, context);
 
 // Intentar generar una respuesta mejorada
 try {
   const correctedResult = await this.openaiService.getChatCompletionWithTools(
     [
       { role: 'system', content: correctionPrompt },
       { role: 'user', content: query }
     ],
     [], // Sin tools para la corrección
     0.3 // Temperatura más baja para corrección
   );
   
   if (correctedResult.content) {
     // Validar la respuesta corregida
     const secondValidation = await this.validateResponse(correctedResult.content, context, query);
     
     if (secondValidation.isValid || secondValidation.issues.length < validation.issues.length) {
       return { 
         validatedResponse: correctedResult.content, 
         issues: secondValidation.issues 
       };
     }
   }
 } catch (error) {
   this.logger.error('Error al intentar corregir respuesta:', error);
 }
 
 // Si no se pudo mejorar, devolver la original con advertencias
 return { validatedResponse: response, issues: validation.issues };
}

private async validateResponse(
 response: string,
 context: ContextResult,
 query: string
): Promise<ValidationResult> {
 const validation: ValidationResult = {
   isValid: true,
   issues: [],
   suggestions: [],
   confidence: 1.0
 };
 
 // Extraer afirmaciones de la respuesta
 const claims = this.extractClaims(response);
 
 // Obtener todos los números del contexto
 const contextNumbers = this.extractNumbersFromContext(context);
 
 for (const claim of claims) {
   // Validar números
   if (claim.hasNumericValue && claim.value !== undefined) {
     if (!this.isNumberInContext(claim.value, contextNumbers)) {
       validation.issues.push({
         type: 'unverified_number',
         value: claim.value,
         claim: claim.text,
         suggestion: 'Este número no se encontró en el contexto proporcionado'
       });
     }
   }
   
   // Validar comparaciones
   if (claim.hasComparison) {
     const comparisonValid = await this.validateComparison(claim, context);
     if (!comparisonValid) {
       validation.issues.push({
         type: 'invalid_comparison',
         claim: claim.text,
         suggestion: 'La comparación puede no ser correcta según los datos'
       });
     }
   }
   
   // Validar referencias ambiguas
   if (this.hasAmbiguousReference(claim.text)) {
     validation.issues.push({
       type: 'ambiguous_reference',
       claim: claim.text,
       suggestion: 'La referencia es ambigua y podría causar confusión'
     });
   }
 }
 
 validation.isValid = validation.issues.length === 0;
 validation.confidence = Math.max(0.3, 1 - (validation.issues.length * 0.2));
 
 return validation;
}

private extractClaims(response: string): Claim[] {
 const claims: Claim[] = [];
 const sentences = response.split(/[.!?]+/).filter(s => s.trim());
 
 sentences.forEach(sentence => {
   const claim: Claim = {
     text: sentence.trim(),
     hasNumericValue: false,
     hasComparison: false,
     entities: TextAnalysisUtils.extractEntities(sentence)
   };
   
   // Detectar valores numéricos
   const numbers = TextAnalysisUtils.extractNumbers(sentence);
   if (numbers.length > 0) {
     claim.hasNumericValue = true;
     claim.value = numbers[0]; // Tomar el primer número como principal
   }
   
   // Detectar comparaciones
   const comparisonPatterns = [
     /\b(?:más|menos|mayor|menor) \w+ (?:que|de)\b/i,
     /\b(?:el|la|los|las) (?:más|menos|mayor|menor)\b/i,
     /\b(?:superior|inferior) a\b/i,
     /\b(?:mejor|peor) que\b/i
   ];
   
   if (comparisonPatterns.some(pattern => pattern.test(sentence))) {
     claim.hasComparison = true;
     
     // Determinar tipo de comparación
     if (/\b(?:más|mayor|superior|mejor)\b/i.test(sentence)) {
       claim.comparisonType = 'greater';
     } else if (/\b(?:menos|menor|inferior|peor)\b/i.test(sentence)) {
       claim.comparisonType = 'lesser';
     }
   }
   
   claims.push(claim);
 });
 
 return claims;
}

private extractNumbersFromContext(context: ContextResult): number[] {
 const allNumbers: number[] = [];
 
 if (context.relevantChunks) {
   context.relevantChunks.forEach(chunk => {
     const numbers = TextAnalysisUtils.extractNumbers(chunk.content);
     allNumbers.push(...numbers);
   });
 }
 
 // También extraer números del contexto de conversación
 if (context.conversationContext) {
   context.conversationContext.forEach(msg => {
     const numbers = TextAnalysisUtils.extractNumbers(msg.content);
     allNumbers.push(...numbers);
   });
 }
 
 return [...new Set(allNumbers)]; // Eliminar duplicados
}

private isNumberInContext(value: number, contextNumbers: number[]): boolean {
 // Verificar coincidencia exacta
 if (contextNumbers.includes(value)) return true;
 
 // Verificar con tolerancia para números decimales
 const tolerance = 0.01;
 return contextNumbers.some(num => Math.abs(num - value) < tolerance);
}

private async validateComparison(claim: Claim, context: ContextResult): Promise<boolean> {
 // Esta es una validación simplificada
 // En una implementación completa, deberías:
 // 1. Identificar qué se está comparando
 // 2. Extraer todos los valores relevantes del contexto
 // 3. Verificar que la comparación es correcta
 
 if (!claim.value || !claim.comparisonType) return true; // No podemos validar sin datos
 
 const contextNumbers = this.extractNumbersFromContext(context);
 
 if (claim.comparisonType === 'greater') {
   // Verificar que no hay números mayores en el contexto
   const largerNumbers = contextNumbers.filter(n => n > claim.value!);
   return largerNumbers.length === 0;
 } else if (claim.comparisonType === 'lesser') {
   // Verificar que no hay números menores en el contexto
   const smallerNumbers = contextNumbers.filter(n => n < claim.value!);
   return smallerNumbers.length === 0;
 }
 
 return true;
}

private hasAmbiguousReference(text: string): boolean {
 const ambiguousTerms = [
   /\b(?:esto|eso|aquello)\b/i,
   /\b(?:el anterior|el siguiente|el último)\b/i,
   /\b(?:algunos|varios|muchos)\b/i,
   /\b(?:cerca de|aproximadamente|más o menos)\b/i
 ];
 
 return ambiguousTerms.some(pattern => pattern.test(text));
}

private createCorrectionPrompt(
 originalResponse: string,
 validation: ValidationResult,
 context: ContextResult
): string {
 let prompt = "Eres un asistente que debe corregir respuestas basándose en validaciones.\n\n";
 
 prompt += "Respuesta original:\n" + originalResponse + "\n\n";
 
 prompt += "Problemas detectados:\n";
 validation.issues.forEach((issue, index) => {
   prompt += `${index + 1}. ${issue.type}: ${issue.suggestion || issue.claim}\n`;
   if (issue.value !== undefined) {
     prompt += `   Valor problemático: ${issue.value}\n`;
   }
 });
 
 prompt += "\nContexto disponible:\n";
 if (context.relevantChunks) {
   context.relevantChunks.forEach((chunk, index) => {
     prompt += `Fragmento ${index + 1}: ${chunk.content.substring(0, 200)}...\n`;
   });
 }
 
 prompt += "\nInstrucciones:\n";
 prompt += "1. Corrige SOLO los problemas identificados\n";
 prompt += "2. Mantén el resto de la respuesta lo más similar posible\n";
 prompt += "3. Usa SOLO información del contexto proporcionado\n";
 prompt += "4. Si no puedes corregir algo con certeza, indícalo claramente\n";
 
 return prompt;
}



    private getRecentValidMessages(conversationContext: Array <(Message | { role: MessageRole; content: string })> | undefined, limit: number): { recentValidMessages: Message[], latestUserMessage: Message | null } {
        if (!conversationContext) return { recentValidMessages: [], latestUserMessage: null };
        
        // Asegurar que todos los elementos sean de tipo Message y filtrar los que no tienen contenido o fallaron
        const validMessages: Message[] = conversationContext
            .map(msg => {
                if ('id' in msg && 'timestamp' in msg) { // Ya es un objeto Message
                    return msg as Message;
                } else { // Es un objeto simple {role, content}, convertir a Message
                    return { 
                        id: uuidv4(), // ID temporal
                        conversationId: 'temp', // ID temporal
                        role: msg.role, 
                        content: msg.content, 
                        senderId: msg.role === MessageRole.USER ? 'user-temp' : 'assistant-temp',
                        timestamp: Date.now(), 
                        status: MessageStatus.SENT, 
                        messageType: MessageType.TEXT, 
                        createdAt: Date.now(),
                        // Asegurarse de que tool_calls (si existe) se mantenga o sea undefined
                        tool_calls: (msg as any).tool_calls 
                    } as Message;
                }
            })
            .filter(msg => msg.status !== MessageStatus.FAILED && (msg.content && msg.content.trim() !== '' || msg.role === 'assistant' && (msg as any).tool_calls?.length > 0) ) // Permitir mensajes de asistente con tool_calls pero sin content
            .sort((a, b) => (Number(a.createdAt || a.timestamp || 0)) - (Number(b.createdAt || b.timestamp || 0)));
        
        const latestUserMessage = [...validMessages].filter(msg => msg.role === MessageRole.USER).pop() || null;
        const recentValidMessages = validMessages.slice(-limit);
        
        return { recentValidMessages, latestUserMessage };
    }

    private mapRoleToOpenAI(role: MessageRole): "system" | "user" | "assistant" {
        switch (role) {
            case MessageRole.SYSTEM: return 'system';
            case MessageRole.ASSISTANT: return 'assistant';
            case MessageRole.USER:
            case MessageRole.HUMAN_AGENT: return 'user'; // Tratar Human Agent como User para el historial del LLM
            default:
                this.logger.warn(`Rol desconocido '${role}' mapeado a 'user'`);
                return 'user';
        }
    }

    private async saveAssistantMessage(
        conversationId: string, agentId: string, content: string,
        responseTime: number, status: MessageStatus = MessageStatus.SENT
    ): Promise<string> {
        const messageId = uuidv4();
        const now = Date.now();
        const newMessage: Message = {
            id: messageId, conversationId, content, role: MessageRole.ASSISTANT, senderId: agentId,
            timestamp: now, responseTime, status, messageType: MessageType.TEXT, createdAt: now
        };
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
            await tableClient.createEntity({
                partitionKey: conversationId, rowKey: messageId, ...newMessage,
                attachments: undefined, metadata: undefined, // Asegurar que no sean objetos vacíos
                errorMessage: status === MessageStatus.FAILED ? content.substring(0,1024) : undefined
            });
            this.logger.debug(`Mensaje del asistente ${messageId} guardado en DB (${status}).`);
            return messageId;
        } catch (error) {
            this.logger.error(`Error al guardar mensaje del asistente ${messageId}:`, error);
            throw error; // Relanzar para que el llamador lo maneje
        }
    }

    private async updateMessageStatus(conversationId: string, messageId: string, status: MessageStatus, errorMessage?: string): Promise<void> {
       try {
           const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
           const updatePayload: any = { partitionKey: conversationId, rowKey: messageId, status: status, updatedAt: Date.now() };
           if (status === MessageStatus.FAILED && errorMessage) { updatePayload.errorMessage = errorMessage.substring(0, 1024); } // Limitar longitud
           else { updatePayload.errorMessage = null; } // Limpiar si no es error
           await tableClient.updateEntity(updatePayload, "Merge");
           this.logger.debug(`Estado del mensaje ${messageId} actualizado a ${status}`);
       } catch (error: any) {
           // No fallar si el mensaje no se encuentra (puede haber sido borrado o es un ID erróneo)
           if (error.statusCode !== 404) {
               this.logger.warn(`Error al actualizar estado del mensaje ${messageId}:`, error);
           }
       }
    }

    private async updateUsageStats(agentId: string, userId: string, inputTokens: number = 0, outputTokens: number = 0): Promise<void> {
       try {
           const totalTokens = (inputTokens || 0) + (outputTokens || 0);
           if (isNaN(totalTokens) || totalTokens <= 0) return; // No hacer nada si no hay tokens o son inválidos

           const today = new Date();
           // Formato YYYY-MM-DD para RowKey y date
           const statDate = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
           
           const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USAGE_STATS);
           const partitionKey = agentId;
           const rowKey = `${userId}_${statDate}`; // Agrupa por usuario y día

           try {
               // Intentar obtener la entidad existente
               const existingStat = await tableClient.getEntity(partitionKey, rowKey);
               // Actualizar contadores
               await tableClient.updateEntity({
                   partitionKey: partitionKey, rowKey: rowKey,
                   inputTokens: (Number(existingStat.inputTokens) || 0) + (inputTokens || 0),
                   outputTokens: (Number(existingStat.outputTokens) || 0) + (outputTokens || 0),
                   totalTokens: (Number(existingStat.totalTokens) || 0) + totalTokens,
                   processedMessages: (Number(existingStat.processedMessages) || 0) + 1, // Incrementar contador de mensajes procesados
                   updatedAt: Date.now()
               }, "Merge");
           } catch (error: any) {
               if (error.statusCode === 404) { // Si la entidad no existe, crearla
                   await tableClient.createEntity({
                       partitionKey: partitionKey, rowKey: rowKey,
                       userId, agentId,
                       period: 'daily', // Podrías tener diferentes periodos (monthly, etc.)
                       date: statDate, // Guardar la fecha en formato YYYY-MM-DD
                       inputTokens: (inputTokens || 0),
                       outputTokens: (outputTokens || 0),
                       totalTokens: totalTokens,
                       processedMessages: 1,
                       createdAt: Date.now(),
                       updatedAt: Date.now()
                   });
               } else {
                   // Relanzar otros errores
                   throw error;
               }
           }
           this.logger.debug(`Estadísticas de uso actualizadas para agente ${agentId}, usuario ${userId}, fecha ${statDate}`);
       } catch (error) {
           this.logger.warn(`Error al actualizar estadísticas de uso para agente ${agentId}:`, error);
           // No detener el flujo principal por errores de estadísticas
       }
    }

    private async queueForSending(conversationId: string, assistantMessageId: string | null, agentId: string, endUserId: string): Promise<void> {
        if (!assistantMessageId) {
            this.logger.warn(`[${conversationId}] Intento de encolar mensaje nulo para envío.`);
            return;
        }
        try {
            const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.SEND_MESSAGE);
            const payload = { conversationId, messageToSendId: assistantMessageId, agentId, recipientId: endUserId };
            await queueClient.sendMessage(Buffer.from(JSON.stringify(payload)).toString('base64'));
            this.logger.info(`[${conversationId}] Mensaje ${assistantMessageId} encolado para envío a ${endUserId}`);
        } catch (error) {
            this.logger.error(`[${conversationId}] Error encolando mensaje ${assistantMessageId} para envío:`, error);
            // Marcar mensaje como fallido si no se puede encolar
            await this.updateMessageStatus(conversationId, assistantMessageId, MessageStatus.FAILED, "Error al encolar para envío");
        }
    }

    private async getAgentSettings(agentId: string): Promise<Agent | null> { 
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
            const agentEntity = await tableClient.getEntity('agent', agentId); 

            let modelConfig = {};
            if (typeof agentEntity.modelConfig === 'string' && agentEntity.modelConfig) {
                try { modelConfig = JSON.parse(agentEntity.modelConfig); } 
                catch (e) { this.logger.warn(`ChatCompletion: Error parseando modelConfig para agente ${agentId}:`, e); }
            } else if (typeof agentEntity.modelConfig === 'object' && agentEntity.modelConfig !== null) {
                modelConfig = agentEntity.modelConfig;
            }

            let operatingHours = null;
            if (typeof agentEntity.operatingHours === 'string' && agentEntity.operatingHours) {
                try { operatingHours = JSON.parse(agentEntity.operatingHours); } 
                catch (e) { this.logger.warn(`ChatCompletion: Error parseando operatingHours para agente ${agentId}:`, e); }
            } else if (typeof agentEntity.operatingHours === 'object') { 
                operatingHours = agentEntity.operatingHours;
            }
            
            let handoffConfig : AgentHandoffConfig | undefined;
            if (typeof agentEntity.handoffConfig === 'string' && agentEntity.handoffConfig) {
                try { handoffConfig = JSON.parse(agentEntity.handoffConfig) as AgentHandoffConfig; }
                catch (e) { this.logger.warn(`ChatCompletion: Error parseando handoffConfig para agente ${agentId}:`, e); }
            } else if (typeof agentEntity.handoffConfig === 'object' && agentEntity.handoffConfig !== null) {
                handoffConfig = agentEntity.handoffConfig as AgentHandoffConfig;
            }


            return {
                id: agentEntity.rowKey as string, 
                userId: agentEntity.userId as string,
                code: agentEntity.code as string,
                name: agentEntity.name as string,
                description: agentEntity.description as string,
                modelType: agentEntity.modelType as string,
                modelConfig: modelConfig as any, 
                systemInstructions: agentEntity.systemInstructions as string,
                temperature: agentEntity.temperature as number,
                isActive: agentEntity.isActive as boolean,
                operatingHours: operatingHours as any, 
                createdAt: agentEntity.createdAt as number,
                handoffEnabled: agentEntity.handoffEnabled as boolean,
                organizationName: agentEntity.organizationName as string | undefined,
                handoffConfig: handoffConfig ? JSON.stringify(handoffConfig) : undefined 
            };
        } catch (error: any) {
            if (error.statusCode === 404) {
                this.logger.error(`Agente ${agentId} no encontrado en getAgentSettings.`);
            } else {
                this.logger.error(`Error al obtener configuración del agente ${agentId} en getAgentSettings:`, error);
            }
            return null;
        }
    }
}