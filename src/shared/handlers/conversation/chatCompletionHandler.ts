import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { OpenAIService } from "../../services/openai.service";
import { STORAGE_TABLES, AI_CONFIG } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import {
    Message,
    MessageRole,
    MessageStatus,
    MessageType,
    ContextResult
} from "../../models/conversation.model";

interface CompletionRequest {
    messageId: string;
    conversationId: string;
    agentId: string;
    userId: string;
    context: ContextResult;
}

export class ChatCompletionHandler {
    private storageService: StorageService;
    private openaiService: OpenAIService;
    private logger: Logger;

    constructor(logger?: Logger) {
        this.storageService = new StorageService();
        this.openaiService = new OpenAIService(logger);
        this.logger = logger || createLogger();
    }

    async execute(request: CompletionRequest): Promise < void > {
        const {
            messageId,
            conversationId,
            agentId,
            userId,
            context
        } = request;

        try {
            // 1. Obtener la configuración del agente
            const agentConfig = await this.getAgentConfig(agentId);

            // 2. Preparar mensajes para OpenAI (CORREGIDO)
            const { messages, latestUserQuery } = this.prepareCompletionMessages(context);

            if (!latestUserQuery) {
                this.logger.warn(`No se encontró una pregunta de usuario válida reciente para el mensaje ${messageId}. Abortando completación.`);
                // Podrías manejar esto enviando un mensaje de error o pidiendo aclaración
                await this.updateMessageStatus(conversationId, messageId, MessageStatus.FAILED, "No se pudo identificar la pregunta del usuario.");
                return;
            }

            // 3. Medir tiempo de inicio para calcular tiempo de respuesta
            const startTime = Date.now();

            // 4. Llamar a OpenAI para generar respuesta
            const response = await this.openaiService.getChatCompletion(
                messages,
                agentConfig.temperature || AI_CONFIG.TEMPERATURE,
                agentConfig.maxTokens || AI_CONFIG.MAX_TOKENS
            );

            // 5. Calcular tiempo de respuesta
            const responseTime = Date.now() - startTime;

            // 6. Guardar respuesta como nuevo mensaje
            await this.saveAssistantMessage(
                conversationId,
                agentId,
                response,
                responseTime
            );

            // 7. Actualizar mensaje original a DELIVERED
            // (Se asume que este mensaje ya fue marcado como procesado por el ContextRetriever)
            // Si es necesario, se podría actualizar aquí también.

            // 8. Actualizar estadísticas de uso (simplificado, longitud como proxy de tokens)
            let inputTokensEstimate = 0;
            messages.forEach(msg => {
                inputTokensEstimate += msg.content.length / 4; // Estimación simple
            });
            await this.updateUsageStats(agentId, userId, Math.ceil(inputTokensEstimate), response.length);

            this.logger.info(`Respuesta generada y guardada para mensaje ${messageId}.`);

            return;
        } catch (error) {
            this.logger.error(`Error al generar respuesta para mensaje ${messageId}:`, error);

            // Actualizar estado del mensaje a FAILED
            await this.updateMessageStatus(conversationId, messageId, MessageStatus.FAILED, `Error en ChatCompletion: ${error instanceof Error ? error.message : String(error)}`);

            // Si es un error de nuestra aplicación, rethrow
            if (error && typeof error === 'object' && 'statusCode' in error) {
                throw error;
            }

            // En otro caso, crear un AppError genérico
            throw createAppError(500, `Error al generar respuesta: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async getAgentConfig(agentId: string): Promise < any > {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
            const agent = await tableClient.getEntity('agent', agentId);

            // Parsear modelConfig si es un string JSON
            let modelConfig = {};
            if (typeof agent.modelConfig === 'string' && agent.modelConfig) {
                try {
                    modelConfig = JSON.parse(agent.modelConfig);
                } catch (e) {
                    this.logger.warn(`Error al parsear modelConfig para agente ${agentId}:`, e);
                }
            } else if (typeof agent.modelConfig === 'object' && agent.modelConfig !== null) {
                modelConfig = agent.modelConfig;
            }

            return {
                temperature: agent.temperature as number | undefined, // Permitir undefined para usar default
                maxTokens: agent.maxTokens as number | undefined,   // Permitir undefined para usar default
                modelType: agent.modelType as string || AI_CONFIG.CHAT_MODEL, // Usar default si no está definido
                modelConfig: modelConfig,
                systemInstructions: agent.systemInstructions as string || ''
            };
        } catch (error) {
            this.logger.error(`Error al obtener configuración del agente ${agentId}. Usando defaults.`, error);
            return {
                temperature: AI_CONFIG.TEMPERATURE,
                maxTokens: AI_CONFIG.MAX_TOKENS,
                modelType: AI_CONFIG.CHAT_MODEL,
                systemInstructions: ''
            };
        }
    }


    /**
     * Prepara los mensajes para enviar a OpenAI, asegurándose de usar el último mensaje de usuario.
     * CORREGIDO: Se enfoca en identificar correctamente el último mensaje válido del usuario.
     */
    private prepareCompletionMessages(context: ContextResult): { messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, latestUserQuery: string | null } {
        const MAX_RECENT_MESSAGES = 6;

        // 1. Obtener historial reciente y válido y última pregunta del usuario
        const { recentValidMessages, latestUserMessage } = this.getRecentValidMessages(context.conversationContext, MAX_RECENT_MESSAGES);
        const latestUserQuery = latestUserMessage ? latestUserMessage.content : null;

        this.logger.info(`Última pregunta de usuario identificada: ${latestUserQuery ? `"${latestUserQuery.substring(0, 50)}..."` : 'Ninguna'}`);

        // 2. Construir el prompt del sistema
        let systemContent = context.systemInstructions || "Eres un asistente útil.";

        // 3. Añadir información sobre integraciones activas
        if (context.activeIntegrations && context.activeIntegrations.length > 0) {
            systemContent += "\n\n### Capacidades e Integraciones Activas:\n";
            systemContent += "Actualmente tienes las siguientes integraciones activas:\n";
            context.activeIntegrations.forEach(int => {
                systemContent += `- ${int.name} (${int.provider} - ${int.type})\n`;
                // Podrías añadir capacidades específicas aquí si las tuvieras disponibles
            });
             systemContent += "Puedes usar estas integraciones si la conversación lo requiere.\n";
            systemContent += "### Fin de Capacidades\n";
        } else {
            systemContent += "\n\nActualmente no tienes integraciones externas activas.\n";
        }


        // 4. Añadir chunks de conocimiento relevantes si existen
        if (context.relevantChunks && context.relevantChunks.length > 0) {
            systemContent += "\n\n### Información Relevante del Contexto:\n";
            context.relevantChunks.forEach((chunk, index) => {
                if (chunk.similarity > 0.7) {
                     systemContent += `--- INICIO Documento ${index + 1} (Similitud: ${chunk.similarity.toFixed(2)}) ---\n${chunk.content}\n--- FIN Documento ${index + 1} ---\n\n`;
                }
            });
            systemContent += "### Fin de la Información Relevante\n";
        }

        // 5. Preparar la lista final de mensajes para OpenAI
        const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

        // Añadir el prompt del sistema compilado
        messages.push({
            role: 'system',
            content: systemContent
        });

        // Añadir el historial reciente de mensajes válidos
        messages.push(...recentValidMessages.map(msg => ({
            role: this.mapRoleToOpenAI(msg.role),
            content: msg.content
        })));

        // 7. Opcional: Añadir una instrucción final si es necesario clarificar la tarea
        if (latestUserQuery) {
             messages.push({
                 role: 'system',
                 content: `Por favor, proporciona una respuesta directa y concisa a la última pregunta del usuario: "${latestUserQuery}"`
             });
        } else {
             // Si no hay una query clara, quizás pedir aclaración o actuar según el último mensaje
             const lastMessage = recentValidMessages[recentValidMessages.length - 1];
             if (lastMessage) {
                 messages.push({
                     role: 'system',
                     content: `Considera el último mensaje en la conversación (${lastMessage.role}): "${lastMessage.content.substring(0, 100)}..." y responde apropiadamente.`
                 });
             } else {
                 messages.push({
                     role: 'system',
                     content: 'Inicia la conversación o responde de manera general si no hay un mensaje previo.'
                 });
             }
        }


        // Depuración: Registrar los mensajes que se enviarán
        this.logger.debug("Mensajes preparados para OpenAI:", messages.map(m => ({ role: m.role, content: m.content.substring(0, 100) + '...' })));


        return { messages, latestUserQuery };
    }

    /**
     * Obtiene los mensajes recientes y válidos, y el último mensaje del usuario.
     * CORREGIDO: Asegura que se filtre por estado y se ordene correctamente por timestamp.
     */
    private getRecentValidMessages(conversationContext: Array <(Message | { role: MessageRole; content: string })> | undefined, limit: number): { recentValidMessages: Message[], latestUserMessage: Message | null } {
        if (!conversationContext || conversationContext.length === 0) {
            return { recentValidMessages: [], latestUserMessage: null };
        }

        // Convertir a objetos Message completos si es necesario y filtrar inválidos
        const validMessages: Message[] = conversationContext
            .map(msg => {
                // Si ya es un objeto Message completo con timestamp y status
                if ('id' in msg && 'timestamp' in msg && 'status' in msg) {
                    return msg as Message;
                }
                // Si es un objeto simple {role, content}, añadir campos necesarios para filtrar/ordenar
                return {
                    id: uuidv4(), // Generar ID temporal si no existe
                    conversationId: 'unknown',
                    role: msg.role,
                    content: msg.content,
                    senderId: 'unknown',
                    timestamp: Date.now(), // Usar timestamp actual si no existe
                    status: MessageStatus.SENT, // Asumir como enviado si no hay estado
                    messageType: MessageType.TEXT,
                    createdAt: Date.now()
                } as Message;
            })
            .filter(msg =>
                msg.status !== MessageStatus.FAILED && // Excluir mensajes fallidos
                msg.content && msg.content.trim() !== '' // Excluir mensajes vacíos
            )
            .sort((a, b) => {
                // Ordenar por timestamp (el más reciente al final)
                 // Convertir a número explícitamente para asegurar comparación correcta
                const timeA = Number(a.timestamp || a.createdAt || 0);
                const timeB = Number(b.timestamp || b.createdAt || 0);
                return timeA - timeB;
            });

        // Obtener el último mensaje del usuario válido
        const latestUserMessage = [...validMessages] // Clonar para no afectar el orden original al revertir
             .reverse()
             .find(msg => msg.role === MessageRole.USER) || null;


        // Tomar los últimos 'limit' mensajes para el contexto
        const recentValidMessages = validMessages.slice(-limit);

        return { recentValidMessages, latestUserMessage };
    }

    // --- Métodos existentes sin cambios significativos (solo añadido manejo de errores en updateMessageStatus) ---

    private mapRoleToOpenAI(role: MessageRole): "system" | "user" | "assistant" {
        switch (role) {
            case MessageRole.SYSTEM:
                return 'system';
            case MessageRole.ASSISTANT:
                return 'assistant';
            case MessageRole.USER:
            case MessageRole.HUMAN_AGENT: // Tratar agentes humanos como usuarios para el modelo AI
                return 'user';
            default:
                 this.logger.warn(`Rol de mensaje desconocido mapeado a 'user': ${role}`);
                return 'user'; // Default seguro
        }
    }

    private async saveAssistantMessage(
        conversationId: string,
        agentId: string,
        content: string,
        responseTime: number
    ): Promise < void > {
        try {
            const messageId = uuidv4();
            const now = Date.now();

            const newMessage: Message = {
                id: messageId,
                conversationId,
                content,
                role: MessageRole.ASSISTANT,
                senderId: agentId, // El remitente es el agente AI
                timestamp: now,
                responseTime,
                status: MessageStatus.SENT, // O DELIVERED si se considera entregado al guardar
                messageType: MessageType.TEXT,
                createdAt: now
                // inputTokens y outputTokens podrían calcularse aquí si la API los devuelve
            };

            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
            await tableClient.createEntity({
                partitionKey: conversationId,
                rowKey: messageId,
                ...newMessage,
                 // Asegurarse de que los campos complejos se serialicen si es necesario
                 attachments: newMessage.attachments ? JSON.stringify(newMessage.attachments) : undefined,
                 metadata: newMessage.metadata ? JSON.stringify(newMessage.metadata) : undefined,
            });

            this.logger.debug(`Respuesta del asistente guardada como mensaje ${messageId}`);
        } catch (error) {
            this.logger.error(`Error al guardar mensaje de asistente para conversación ${conversationId}:`, error);
            // No lanzar error aquí directamente, el error principal se manejará en execute()
            throw createAppError(500, "Error interno al guardar la respuesta del asistente.");
        }
    }

    private async updateMessageStatus(conversationId: string, messageId: string, status: MessageStatus, errorMessage ? : string): Promise < void > {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
            const updatePayload: any = {
                partitionKey: conversationId,
                rowKey: messageId,
                status: status,
                updatedAt: Date.now()
            };

            // Añadir mensaje de error si el estado es FAILED
            if (status === MessageStatus.FAILED && errorMessage) {
                 // Truncar mensaje de error si es muy largo para Table Storage
                 updatePayload.errorMessage = errorMessage.substring(0, 1024);
            }

            await tableClient.updateEntity(updatePayload, "Merge");

            this.logger.debug(`Estado del mensaje ${messageId} actualizado a ${status}`);
        } catch (error: any) {
             // Evitar error si la entidad no se encuentra (podría haber sido eliminada)
            if (error.statusCode !== 404) {
                 this.logger.warn(`Error al actualizar estado del mensaje ${messageId} a ${status}:`, error);
            }
            // No propagar error para no interrumpir flujo principal
        }
    }

    private async updateUsageStats(agentId: string, userId: string, inputTokens: number, outputLength: number): Promise<void> {
        try {
             // Estimación muy simple de tokens de salida
            const outputTokens = Math.ceil(outputLength / 4);
            const totalTokens = Math.ceil(inputTokens) + outputTokens;

            // Generar clave para el registro de estadísticas (por día)
            const today = new Date();
             // Usar formato YYYY-MM-DD para consistencia
            const statId = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;


            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USAGE_STATS);
            const partitionKey = agentId; // Usar agentId como partición podría ser mejor para consultas por agente
            const rowKey = `${userId}_${statId}`; // Combinar usuario y día

            try {
                 // Intentar obtener la entidad existente
                 const existingStat = await tableClient.getEntity(partitionKey, rowKey);

                 // Si existe, actualizar sumando los nuevos valores
                 await tableClient.updateEntity({
                     partitionKey: partitionKey,
                     rowKey: rowKey,
                      // Sumar de forma segura, tratando los valores existentes como números
                     inputTokens: (Number(existingStat.inputTokens) || 0) + inputTokens,
                     outputTokens: (Number(existingStat.outputTokens) || 0) + outputTokens,
                     totalTokens: (Number(existingStat.totalTokens) || 0) + totalTokens,
                     processedMessages: (Number(existingStat.processedMessages) || 0) + 1,
                     updatedAt: Date.now()
                 }, "Merge");

             } catch (error: any) {
                 // Si no existe (error 404), crear una nueva entrada
                 if (error.statusCode === 404) {
                     await tableClient.createEntity({
                         partitionKey: partitionKey,
                         rowKey: rowKey,
                         userId,
                         agentId,
                         period: 'daily',
                         date: statId, // Guardar la fecha YYYY-MM-DD
                         inputTokens: inputTokens,
                         outputTokens: outputTokens,
                         totalTokens: totalTokens,
                         processedMessages: 1,
                         createdAt: Date.now(),
                         updatedAt: Date.now()
                     });
                 } else {
                     // Si es otro error, registrarlo
                     throw error;
                 }
             }
             this.logger.debug(`Estadísticas de uso actualizadas para agente ${agentId}, usuario ${userId}`);
        } catch (error) {
            this.logger.warn(`Error al actualizar estadísticas de uso para agente ${agentId}:`, error);
            // No propagar error
        }
    }
}