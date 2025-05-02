// src/shared/handlers/conversation/chatCompletionHandler.ts

import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { OpenAIService, ChatCompletionResult, OpenAITool, OpenAIToolCall } from "../../services/openai.service";
import { IntegrationExecutorHandler } from "../integrations/integrationExecutorHandler";
// Importa otros handlers específicos si los necesitas directamente aquí (aunque IntegrationExecutor debería bastar)
import { STORAGE_TABLES, AI_CONFIG, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils";
import {
    Message, MessageRole, MessageStatus, MessageType, ContextResult, IntegrationInfo
} from "../../models/conversation.model";
import { IntegrationAction, IntegrationType, IntegrationCatalogItem, CapabilityToolDefinition, IntegrationStatus } from "../../models/integration.model";
import { TableClient } from "@azure/data-tables";
import fetch from "node-fetch"; // O usa el fetch nativo si está disponible

/**
 * Estructura esperada del mensaje en la cola de completación.
 */
interface CompletionRequest {
    messageId: string; // ID del mensaje del *usuario* que disparó esto
    conversationId: string;
    agentId: string;
    userId: string; // ID del usuario final (ej. whatsapp:...)
    context: ContextResult;
    // Opcional: Mensaje del asistente que hizo la llamada a la herramienta original (si aplica)
    // Este campo NO viene de la cola inicial, se pasa internamente en llamadas recursivas.
    assistantMessageRequestingTool?: OpenAIMessage;
}

/**
 * Tipo unificado para los mensajes que se envían a OpenAI.
 * Incluye el rol "tool" que es necesario para devolver resultados de herramientas.
 */
type OpenAIMessage = {
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    name?: string; // Requerido para role: "tool"
    tool_call_id?: string; // Requerido para role: "tool"
    tool_calls?: OpenAIToolCall[]; // Presente en role: "assistant" cuando pide tools
};


export class ChatCompletionHandler {
    private storageService: StorageService;
    private openaiService: OpenAIService;
    private integrationExecutor: IntegrationExecutorHandler;
    private logger: Logger;
    private catalogCache: IntegrationCatalogItem[] | null = null;
    private maxToolRecursionDepth = 3; // Límite para evitar bucles infinitos

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.logger = logger || createLogger();
        this.openaiService = new OpenAIService(this.logger);
        // IntegrationExecutor orquesta las llamadas a los handlers específicos
        this.integrationExecutor = new IntegrationExecutorHandler(this.logger);
    }

    /**
     * Punto de entrada principal. Procesa la solicitud de la cola 'completion-queue'.
     * Prepara el contexto inicial y realiza la primera llamada a OpenAI.
     */
    async execute(request: CompletionRequest): Promise<void> {
        const { messageId, conversationId, agentId, userId, context } = request;
        let assistantMessageId: string | null = null; // ID del mensaje que guardaremos del asistente

        try {
            this.logger.info(`[${conversationId}] Iniciando ChatCompletion para msg ${messageId}...`);

            // 1. Obtener configuración del agente
            const agentConfig = await this.getAgentConfig(agentId);

            // 2. Obtener herramientas disponibles basadas en integraciones activas
            const availableTools = await this.getToolsForAgent(context.activeIntegrations || []);

            // 3. Preparar el historial y el prompt para la primera llamada a OpenAI
            const { messages, latestUserQuery } = this.prepareCompletionMessages(
                context, agentConfig.systemInstructions, availableTools
            );

            // Validar que haya algo que procesar
            if (!latestUserQuery && messages.length <= 1) {
                this.logger.warn(`[${conversationId}] Sin consulta de usuario ni historial para msg ${messageId}. Abortando.`);
                return;
            }

            // 4. Realizar la primera llamada a OpenAI
            const startTime = Date.now();
            this.logger.info(`[${conversationId}] Llamando a OpenAI API (1ra llamada)...`);
            const completionResult: ChatCompletionResult = await this.openaiService.getChatCompletionWithTools(
                // Cast a tipo esperado por la función (sin rol 'tool')
                messages.filter(m => m.role !== 'tool') as { role: "system" | "user" | "assistant"; content: string | null; }[],
                availableTools,
                agentConfig.temperature ?? AI_CONFIG.TEMPERATURE,
                agentConfig.maxTokens ?? AI_CONFIG.MAX_TOKENS
            );
            const responseTime = Date.now() - startTime;
            this.logger.info(`[${conversationId}] Respuesta de OpenAI recibida en ${responseTime}ms.`);

            // 5. Procesar la respuesta de OpenAI
            // Usar las propiedades directas de ChatCompletionResult
            const assistantContent = completionResult.content;
            const assistantToolCalls = completionResult.toolCalls;

            // Reconstruir el objeto 'message' del asistente para pasarlo a la lógica multi-paso
            const assistantResponseObject: OpenAIMessage = {
                role: "assistant",
                content: assistantContent,
                // Incluir tool_calls solo si existen
                ...(assistantToolCalls && assistantToolCalls.length > 0 && { tool_calls: assistantToolCalls })
            };

            if (!assistantResponseObject) {
                 this.logger.error(`[${conversationId}] Respuesta inválida de OpenAI (sin message reconstruido).`);
                 throw new Error("Respuesta inválida de OpenAI.");
            }

            if (assistantToolCalls?.length) {
                // Caso 1: OpenAI solicitó llamadas a herramientas
                this.logger.info(`[${conversationId}] OpenAI solicitó ${assistantToolCalls.length} tool calls.`);
                await this.processToolCallsSequentially(
                    assistantToolCalls,
                    assistantResponseObject, // Pasar el objeto 'message' reconstruido del asistente
                    messages, // Pasar el historial original enviado a OpenAI
                    context,
                    agentId,
                    userId, // endUserId
                    conversationId,
                    messageId, // ID del mensaje original del usuario
                    responseTime, // Tiempo de la primera llamada
                    1 // Profundidad inicial
                );
            } else if (assistantContent) {
                // Caso 2: OpenAI generó una respuesta de texto directamente
                this.logger.info(`[${conversationId}] OpenAI generó respuesta de texto directamente.`);
                assistantMessageId = await this.saveAssistantMessage(conversationId, agentId, assistantContent, responseTime);
                if (assistantMessageId) {
                    await this.queueForSending(conversationId, assistantMessageId, agentId, userId);
                }
            } else {
                // Caso 3: Respuesta vacía (ni contenido ni tools)
                this.logger.warn(`[${conversationId}] OpenAI respuesta vacía (sin contenido ni tool_calls) para msg ${messageId}`);
                assistantMessageId = await this.saveAssistantMessage(conversationId, agentId, "(No hubo respuesta del asistente)", responseTime, MessageStatus.FAILED);
            }

            // 6. Actualizar estadísticas de uso (si aplica)
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

    /**
     * Procesa una lista de tool calls secuencialmente. Ejecuta cada herramienta,
     * recopila los resultados y luego vuelve a llamar a OpenAI para obtener la respuesta final.
     * Maneja la recursión hasta una profundidad máxima.
     */
    private async processToolCallsSequentially(
        toolCalls: OpenAIToolCall[],
        assistantMessageRequestingTools: OpenAIMessage, // El objeto 'message' del asistente que pidió las tools
        previousMessages: OpenAIMessage[], // Historial enviado en la llamada anterior
        context: ContextResult,
        agentId: string,
        endUserId: string,
        conversationId: string,
        originalUserMessageId: string, // ID del mensaje del usuario que inició todo
        responseTimeSoFar: number,
        depth: number // Para control de recursión
    ): Promise<void> {

        if (depth > this.maxToolRecursionDepth) {
            this.logger.error(`[${conversationId}] Profundidad máxima de llamadas a herramientas (${this.maxToolRecursionDepth}) alcanzada para msg ${originalUserMessageId}. Abortando.`);
            const errorMsgId = await this.saveAssistantMessage(conversationId, agentId, "No pude completar la acción solicitada porque es demasiado compleja.", responseTimeSoFar, MessageStatus.FAILED);
            if (errorMsgId) await this.queueForSending(conversationId, errorMsgId, agentId, endUserId);
            return;
        }

        const toolResultMessages: OpenAIMessage[] = [];
        let cumulativeResponseTime = responseTimeSoFar;
        let executionFailed = false; // Flag para saber si alguna herramienta falló
        let currentToolProcessingStartTime = Date.now(); // Inicializar tiempo

        this.logger.info(`[${conversationId}] Procesando ${toolCalls.length} tool calls (Profundidad ${depth})...`);

        for (const toolCall of toolCalls) {
            currentToolProcessingStartTime = Date.now(); // Reiniciar para cada tool call
            const functionName = toolCall.function.name;
            let functionArgs: Record<string, any> = {};
            let executionResult: { success: boolean, result?: any, error?: string, details?: any, statusCode?: number } | null = null;
            let toolResultMessageContent = "";

            try {
                // 1. Parsear argumentos
                try { functionArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { throw new Error(`Argumentos inválidos (no es JSON) para ${functionName}. Args: ${toolCall.function.arguments}`); }
                this.logger.info(`[${conversationId}] Procesando tool call (Profundidad ${depth}): ${functionName} con args:`, functionArgs);

                // 2. Mapear a acción de integración
                const actionInfo = this.mapFunctionToIntegrationAction(functionName, functionArgs, context.activeIntegrations || []);
                if (!actionInfo) { throw new Error(`No se pudo mapear '${functionName}' a una integración/acción activa.`); }

                // 3. Crear objeto de acción y ejecutar
                const action: IntegrationAction = {
                    integrationId: actionInfo.integrationId,
                    action: actionInfo.action,
                    parameters: functionArgs,
                    userId: endUserId,
                    conversationId,
                    messageId: originalUserMessageId,
                    async: false
                };

                this.logger.info(`[${conversationId}] Ejecutando integración ${action.integrationId.substring(0,8)}..., acción interna: ${action.action}`);
                executionResult = await this.integrationExecutor.execute(action, endUserId);

                // 4. Formatear resultado
                if (executionResult?.success) {
                    toolResultMessageContent = `Resultado de ${functionName}: ${JSON.stringify(executionResult.result ?? 'Éxito sin datos').substring(0, 1500)}`;
                    this.logger.info(`[${conversationId}] Ejecución ${functionName} (Profundidad ${depth}) exitosa.`);
                } else {
                    executionFailed = true;
                    const errorMsg = executionResult?.error || 'Error desconocido durante la ejecución.';
                    toolResultMessageContent = `Error en ${functionName}: ${errorMsg}`;
                    this.logger.error(`[${conversationId}] Fallo en la ejecución de ${functionName} (Profundidad ${depth}): ${errorMsg}`, executionResult?.details);
                }

            } catch (error: any) {
                executionFailed = true;
                this.logger.error(`[${conversationId}] Error crítico procesando tool call ${functionName} (Profundidad ${depth}):`, error);
                toolResultMessageContent = `Error técnico al ejecutar ${functionName}: ${error.message || 'Error desconocido'}`;
                executionResult = { success: false, error: error.message };
            } finally {
                cumulativeResponseTime += (Date.now() - currentToolProcessingStartTime); // Usar la variable correcta
                toolResultMessages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: functionName,
                    content: toolResultMessageContent,
                });
            }
        } // Fin del bucle for toolCalls

        // 5. Construir historial para la siguiente llamada a OpenAI
        const messagesForNextCall: OpenAIMessage[] = [
            ...previousMessages,
            assistantMessageRequestingTools, // Incluir el mensaje original del asistente
            ...toolResultMessages // Añadir todos los resultados de las tools
        ];

        this.logger.info(`[${conversationId}] Re-llamando a OpenAI (Profundidad ${depth + 1}) después de procesar ${toolCalls.length} tool calls. ¿Alguna falló?: ${executionFailed}`);

        // 6. Llamar a OpenAI de nuevo
        const agentConfig = await this.getAgentConfig(agentId);
        const availableTools = await this.getToolsForAgent(context.activeIntegrations || []);
        const nextCompletionResult = await this.openaiService.getChatCompletionWithTools(
            // Cast temporal a 'any[]' para la llamada
            messagesForNextCall as any[],
            availableTools,
            agentConfig.temperature ?? AI_CONFIG.TEMPERATURE,
            agentConfig.maxTokens ?? AI_CONFIG.MAX_TOKENS
        );
        const finalResponseTime = cumulativeResponseTime; // Usar el tiempo acumulado

        // 7. Procesar la SIGUIENTE respuesta de OpenAI
        // Usar las propiedades directas de ChatCompletionResult
        const nextAssistantContent = nextCompletionResult.content;
        const nextToolCalls = nextCompletionResult.toolCalls;
        // Reconstruir el objeto 'message' para la siguiente iteración si es necesario
        const nextAssistantMessageObject: OpenAIMessage = {
            role: "assistant",
            content: nextAssistantContent,
            ...(nextToolCalls && nextToolCalls.length > 0 && { tool_calls: nextToolCalls })
        };

        if (!nextAssistantMessageObject) {
             this.logger.error(`[${conversationId}] Respuesta inválida de OpenAI en la segunda llamada (sin message reconstruido).`);
             throw new Error("Respuesta inválida de OpenAI en segunda llamada.");
        }


        if (nextToolCalls?.length) {
            // Caso A: OpenAI pide MÁS herramientas
            this.logger.info(`[${conversationId}] OpenAI solicitó OTRA herramienta (Profundidad ${depth + 1}): ${nextToolCalls[0].function.name}`);
            await this.processToolCallsSequentially(
                nextToolCalls,
                nextAssistantMessageObject, // Pasar el *nuevo* mensaje del asistente
                messagesForNextCall, // Pasar el historial que incluye resultados anteriores
                context, agentId, endUserId, conversationId, originalUserMessageId,
                finalResponseTime, // Pasar tiempo acumulado
                depth + 1 // Incrementar profundidad
            );
        } else if (nextAssistantContent) {
            // Caso B: OpenAI genera la respuesta final en texto
            this.logger.info(`[${conversationId}] OpenAI generó respuesta final en texto (Profundidad ${depth + 1}).`);
            const finalAssistantMessageId = await this.saveAssistantMessage(conversationId, agentId, nextAssistantContent, finalResponseTime);
            if (finalAssistantMessageId) {
                await this.queueForSending(conversationId, finalAssistantMessageId, agentId, endUserId);
            }
            if (nextCompletionResult.usage) {
                await this.updateUsageStats(agentId, endUserId, nextCompletionResult.usage.prompt_tokens, nextCompletionResult.usage.completion_tokens);
            }
        } else {
            // Caso C: OpenAI no devuelve nada útil
            this.logger.warn(`[${conversationId}] La llamada a OpenAI (Profundidad ${depth + 1}) no produjo contenido ni herramientas.`);
            const fallbackMsg = executionFailed
                ? "Tuve problemas al realizar una de las acciones necesarias. ¿Podrías intentarlo de nuevo o reformular tu petición?"
                : "No pude completar la acción solicitada después de consultar la información necesaria.";
            const fallbackMsgId = await this.saveAssistantMessage(conversationId, agentId, fallbackMsg, finalResponseTime, MessageStatus.FAILED);
            if (fallbackMsgId) { await this.queueForSending(conversationId, fallbackMsgId, agentId, endUserId); }
        }
    }


    // --- Métodos Auxiliares (Implementaciones completas requeridas) ---

    private mapFunctionToIntegrationAction(
        functionName: string, args: Record<string, any>, activeIntegrations: IntegrationInfo[]
    ): { integrationId: string; action: string } | null {
         let targetIntegration: IntegrationInfo | undefined;
         let targetAction: string = '';

         const googleCalendarIntegration = activeIntegrations.find(int => int.provider === 'google' && int.type === IntegrationType.CALENDAR);
         const whatsAppIntegration = activeIntegrations.find(int => int.provider === 'whatsapp' && int.type === IntegrationType.MESSAGING);
         const microsoftIntegration = activeIntegrations.find(int => int.provider === 'microsoft');
         const erpIntegration = activeIntegrations.find(int => int.type === IntegrationType.ERP);

         this.logger.debug(`Mapeando función: ${functionName}. Integraciones activas: ${activeIntegrations.map(i => i.name + '('+i.id.substring(0,4)+')').join(', ')}`);

         switch (functionName) {
             // Google Calendar
             case 'getGoogleCalendarEvents': targetIntegration = googleCalendarIntegration; targetAction = 'getEvents'; break;
             case 'createGoogleCalendarEvent': targetIntegration = googleCalendarIntegration; targetAction = 'createEvent'; break;
             case 'updateGoogleCalendarEvent': targetIntegration = googleCalendarIntegration; targetAction = 'updateEvent'; break;
             case 'deleteGoogleCalendarEvent': targetIntegration = googleCalendarIntegration; targetAction = 'deleteEvent'; break;
             // WhatsApp
             case 'sendWhatsAppTextMessage': targetIntegration = whatsAppIntegration; targetAction = 'sendMessage'; break;
             case 'sendWhatsAppTemplateMessage': targetIntegration = whatsAppIntegration; targetAction = 'sendTemplate'; break;
             // Microsoft Graph (Ejemplos)
             case 'getMicrosoftEvents': targetIntegration = microsoftIntegration; targetAction = 'getEvents'; break;
             case 'createMicrosoftEvent': targetIntegration = microsoftIntegration; targetAction = 'createEvent'; break;
             case 'sendMicrosoftEmail': targetIntegration = microsoftIntegration; targetAction = 'sendMail'; break;
             // ERP (Ejemplos)
             case 'queryErpData': targetIntegration = erpIntegration; targetAction = 'queryData'; break;
             case 'createErpRecord': targetIntegration = erpIntegration; targetAction = 'createRecord'; break;

             default: this.logger.warn(`Función sin mapeo definido: ${functionName}`); return null;
         }

         if (!targetIntegration) {
             this.logger.warn(`Integración necesaria para '${functionName}' no está activa o no se encontró.`);
             return null;
         }
          this.logger.debug(`Mapeado ${functionName} a ${targetIntegration.provider} (${targetIntegration.id.substring(0,4)}) - Acción Interna: ${targetAction}`);
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

            for (const item of this.catalogCache) {
                 const isActive = activeIntegrations.some(activeInt =>
                     activeInt.provider === item.provider && activeInt.type === item.type
                 );

                if (isActive) {
                    this.logger.debug(`Procesando catálogo activo: ${item.name} (Tipo: ${item.type}, Provider: ${item.provider})`);
                    if (item.capabilityTools?.length) {
                        for (const toolDef of item.capabilityTools) {
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
                                this.logger.warn(`Definición de herramienta inválida o incompleta en catálogo ${item.name}:`, toolDef);
                            }
                        }
                    } else {
                         this.logger.debug(` -> Sin herramientas definidas en catálogo para ${item.name}`);
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
                            id: entity.rowKey,
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

    private prepareCompletionMessages(
        context: ContextResult, systemInstructionsBase: string, availableTools: OpenAITool[]
    ): { messages: OpenAIMessage[], latestUserQuery: string | null } {

        const MAX_RECENT_MESSAGES = 10;
        const { recentValidMessages, latestUserMessage } = this.getRecentValidMessages(context.conversationContext, MAX_RECENT_MESSAGES);
        const latestUserQuery = latestUserMessage ? latestUserMessage.content : null;

        let systemContent = systemInstructionsBase || "Eres un asistente útil.";
        const now = new Date();
        const timeZone = 'America/Mexico_City';
        try {
            const currentDateTime = now.toLocaleString('es-MX', { timeZone, dateStyle: 'full', timeStyle: 'long' });
            systemContent += `\n\nFecha y Hora Actual: ${currentDateTime} (${timeZone}).`;
        } catch (e) {
            this.logger.warn("Error formateando fecha/hora local, usando UTC:", e);
            systemContent += `\n\nFecha y Hora Actual: ${now.toISOString()}.`;
        }

        systemContent += "\n\n### Herramientas Disponibles (Funciones):\n";
        if (availableTools.length > 0) {
            systemContent += "Puedes usar las siguientes herramientas si una acción externa es necesaria:\n";
            availableTools.forEach(tool => { systemContent += `- ${tool.function.name}: ${tool.function.description}\n`; });
            systemContent += "\n**Importante:** Si decides usar una herramienta, responde ÚNICAMENTE con el JSON necesario para 'tool_calls'. No añadas texto adicional antes o después del JSON.";
        } else { systemContent += "No hay herramientas externas disponibles en este momento."; }
        systemContent += "\n### Fin Herramientas\n";

        systemContent += "\n\n### Capacidades e Integraciones Activas:\n";
        if (context.activeIntegrations && context.activeIntegrations.length > 0) {
            systemContent += "Tienes acceso a las siguientes integraciones:\n";
            context.activeIntegrations.forEach(int => { systemContent += `- ${int.name} (${int.provider} - ${int.type})\n`; });
        } else { systemContent += "No hay integraciones externas activas.\n"; }
        systemContent += "### Fin Capacidades\n";

        if (context.relevantChunks?.length > 0) {
            systemContent += "\n\n### Información Relevante Adicional (Base de Conocimiento):\n";
            systemContent += "Considera esta información para formular tu respuesta si es relevante para la consulta del usuario:\n";
            context.relevantChunks.forEach((chunk, index) => {
                 const truncatedContent = chunk.content.substring(0, 500) + (chunk.content.length > 500 ? "..." : "");
                 systemContent += `--- Contexto ${index + 1} (Doc: ${chunk.documentId.substring(0,6)}..., Chunk: ${chunk.chunkId.substring(0,6)}..., Sim: ${chunk.similarity.toFixed(2)}) ---\n${truncatedContent}\n--- FIN Contexto ${index + 1} ---\n\n`;
            });
            systemContent += "**Si la información relevante contradice tu conocimiento general, prioriza la información relevante.**\n";
            systemContent += "### Fin Información Relevante\n";
        }

        systemContent += "\n**Instrucción Principal:** Basándote en el historial de la conversación, la información relevante (si la hay) y las herramientas disponibles, responde a la ÚLTIMA solicitud del usuario de forma útil y concisa. Si necesitas realizar una acción externa (como crear un evento o enviar un mensaje), utiliza la herramienta apropiada. De lo contrario, proporciona una respuesta directa en texto.";

        const messages: OpenAIMessage[] = [];
        messages.push({ role: 'system', content: systemContent });
        messages.push(...recentValidMessages.map(msg => ({
            role: this.mapRoleToOpenAI(msg.role),
            content: msg.content ?? null
        })));

        this.logger.debug("Mensajes preparados para OpenAI:", JSON.stringify(messages.map(m => ({ role: m.role, hasContent: !!m.content })), null, 2));
        return { messages, latestUserQuery };
    }

    private getRecentValidMessages(conversationContext: Array <(Message | { role: MessageRole; content: string })> | undefined, limit: number): { recentValidMessages: Message[], latestUserMessage: Message | null } {
        if (!conversationContext) return { recentValidMessages: [], latestUserMessage: null };
        const validMessages: Message[] = conversationContext
            .map(msg => ('id' in msg && 'timestamp' in msg)
                ? msg as Message
                : { id: uuidv4(), conversationId: 'temp', role: msg.role, content: msg.content, senderId: 'temp', timestamp: Date.now(), status: MessageStatus.SENT, messageType: MessageType.TEXT, createdAt: Date.now() } as Message
            )
            .filter(msg => msg.status !== MessageStatus.FAILED && msg.content && msg.content.trim() !== '')
            .sort((a, b) => (Number(a.createdAt || a.timestamp || 0)) - (Number(b.createdAt || b.timestamp || 0)));
        const latestUserMessage = [...validMessages].reverse().find(msg => msg.role === MessageRole.USER) || null;
        const recentValidMessages = validMessages.slice(-limit);
        return { recentValidMessages, latestUserMessage };
    }

    private mapRoleToOpenAI(role: MessageRole): "system" | "user" | "assistant" {
        switch (role) {
            case MessageRole.SYSTEM: return 'system';
            case MessageRole.ASSISTANT: return 'assistant';
            case MessageRole.USER:
            case MessageRole.HUMAN_AGENT: return 'user';
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
                attachments: undefined, metadata: undefined,
                errorMessage: status === MessageStatus.FAILED ? content.substring(0,1024) : undefined
            });
            this.logger.debug(`Mensaje del asistente ${messageId} guardado en DB (${status}).`);
            return messageId;
        } catch (error) {
            this.logger.error(`Error al guardar mensaje del asistente ${messageId}:`, error);
            throw error;
        }
    }

    private async updateMessageStatus(conversationId: string, messageId: string, status: MessageStatus, errorMessage?: string): Promise<void> {
       try {
           const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
           const updatePayload: any = { partitionKey: conversationId, rowKey: messageId, status: status, updatedAt: Date.now() };
           if (status === MessageStatus.FAILED && errorMessage) { updatePayload.errorMessage = errorMessage.substring(0, 1024); }
           else { updatePayload.errorMessage = null; }
           await tableClient.updateEntity(updatePayload, "Merge");
           this.logger.debug(`Estado del mensaje ${messageId} actualizado a ${status}`);
       } catch (error: any) {
           if (error.statusCode !== 404) { this.logger.warn(`Error al actualizar estado del mensaje ${messageId}:`, error); }
       }
    }

    private async updateUsageStats(agentId: string, userId: string, inputTokens: number = 0, outputTokens: number = 0): Promise<void> {
       try {
           const totalTokens = (inputTokens || 0) + (outputTokens || 0);
           if (isNaN(totalTokens) || totalTokens <= 0) return;
           const today = new Date();
           const statDate = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
           const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USAGE_STATS);
           const partitionKey = agentId;
           const rowKey = `${userId}_${statDate}`;
           try {
               const existingStat = await tableClient.getEntity(partitionKey, rowKey);
               await tableClient.updateEntity({
                   partitionKey: partitionKey, rowKey: rowKey,
                   inputTokens: (Number(existingStat.inputTokens) || 0) + (inputTokens || 0),
                   outputTokens: (Number(existingStat.outputTokens) || 0) + (outputTokens || 0),
                   totalTokens: (Number(existingStat.totalTokens) || 0) + totalTokens,
                   processedMessages: (Number(existingStat.processedMessages) || 0) + 1,
                   updatedAt: Date.now()
               }, "Merge");
           } catch (error: any) {
               if (error.statusCode === 404) {
                   await tableClient.createEntity({
                       partitionKey: partitionKey, rowKey: rowKey, userId, agentId, period: 'daily', date: statDate,
                       inputTokens: (inputTokens || 0), outputTokens: (outputTokens || 0), totalTokens: totalTokens,
                       processedMessages: 1, createdAt: Date.now(), updatedAt: Date.now()
                   });
               } else { throw error; }
           }
           this.logger.debug(`Estadísticas de uso actualizadas para agente ${agentId}, usuario ${userId}`);
       } catch (error) {
           this.logger.warn(`Error al actualizar estadísticas de uso para agente ${agentId}:`, error);
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
            await this.updateMessageStatus(conversationId, assistantMessageId, MessageStatus.FAILED, "Error al encolar para envío");
        }
    }

} // Fin de la clase ChatCompletionHandler
