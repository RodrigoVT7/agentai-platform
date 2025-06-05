import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import {
  Message,
  MessageRole,
  MessageStatus,
  MessageType,
  ContextResult,
} from "../../models/conversation.model";
import fetch from "node-fetch";

interface N8nCompletionRequest {
  messageId: string;
  conversationId: string;
  agentId: string;
  userId: string;
  context: ContextResult;
}

export class N8nChatCompletionHandler {
  private storageService: StorageService;
  private logger: Logger;
  private n8nWebhookUrl: string;

  constructor(n8nWebhookUrl: string, logger?: Logger) {
    if (!n8nWebhookUrl) {
      throw createAppError(500, "N8N webhook URL is required");
    }
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
    this.n8nWebhookUrl = n8nWebhookUrl;
  }

  async execute(request: N8nCompletionRequest): Promise<void> {
    const { messageId, conversationId, agentId, userId, context } = request;
    let assistantMessageId: string | null = null;

    try {
      this.logger.info(
        `[${conversationId}] Iniciando N8nChatCompletion para msg ${messageId}...`
      );

      const agentConfig = await this.getAgentConfig(agentId);
      const { messages, latestUserQuery } =
        await this.prepareCompletionMessages(
          context,
          agentConfig.systemInstructions
        );

      if (!latestUserQuery && messages.length <= 1) {
        this.logger.warn(
          `[${conversationId}] Sin consulta de usuario ni historial para msg ${messageId}. Abortando.`
        );
        return;
      }

      const startTime = Date.now();
      this.logger.info(`[${conversationId}] Llamando a n8n webhook...`);

      const response = await fetch(this.n8nWebhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messageId,
          conversationId,
          agentId,
          userId,
          messages,
          systemInstructions: agentConfig.systemInstructions,
          temperature: agentConfig.temperature,
        }),
      });

      if (!response.ok) {
        throw createAppError(
          response.status,
          `Error en llamada a n8n: ${response.statusText}`
        );
      }

      const responseData = await response.json();
      const responseTime = Date.now() - startTime;
      this.logger.info(
        `[${conversationId}] Respuesta de n8n recibida en ${responseTime}ms.`
      );

      if (responseData.content) {
        assistantMessageId = await this.saveAssistantMessage(
          conversationId,
          agentId,
          responseData.content,
          responseTime,
          MessageStatus.SENT
        );

        if (assistantMessageId) {
          await this.queueForSending(
            conversationId,
            assistantMessageId,
            agentId,
            userId
          );
        }
      } else {
        this.logger.warn(
          `[${conversationId}] n8n respuesta vacía para msg ${messageId}`
        );
        assistantMessageId = await this.saveAssistantMessage(
          conversationId,
          agentId,
          "(No hubo respuesta del asistente)",
          responseTime,
          MessageStatus.FAILED
        );
      }

      this.logger.info(
        `[${conversationId}] N8nChatCompletion para msg ${messageId} completado.`
      );
    } catch (error) {
      this.logger.error(
        `[${conversationId}] Error fatal en N8nChatCompletionHandler para msg ${messageId}:`,
        error
      );
      try {
        assistantMessageId = await this.saveAssistantMessage(
          conversationId,
          agentId,
          "Lo siento, ocurrió un error interno al procesar tu solicitud.",
          0,
          MessageStatus.FAILED
        );
        if (assistantMessageId) {
          await this.queueForSending(
            conversationId,
            assistantMessageId,
            agentId,
            userId
          );
        }
      } catch (saveError) {
        this.logger.error(
          `[${conversationId}] Error CRÍTICO al intentar guardar/enviar mensaje de error al usuario:`,
          saveError
        );
      }
    }
  }

  private async getAgentConfig(agentId: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.AGENTS
      );
      const agent = await tableClient.getEntity("agent", agentId);
      let modelConfig = {};
      if (typeof agent.modelConfig === "string" && agent.modelConfig) {
        try {
          modelConfig = JSON.parse(agent.modelConfig);
        } catch (e) {
          this.logger.warn(`Error parseando modelConfig: ${e}`);
        }
      } else if (
        typeof agent.modelConfig === "object" &&
        agent.modelConfig !== null
      ) {
        modelConfig = agent.modelConfig;
      }
      return {
        temperature: (agent.temperature as number | undefined) ?? 0.7,
        systemInstructions: (agent.systemInstructions as string) || "",
      };
    } catch (error) {
      this.logger.error(
        `Error al obtener config agente ${agentId}. Usando defaults.`,
        error
      );
      return { temperature: 0.7, systemInstructions: "" };
    }
  }

  private async prepareCompletionMessages(
    context: ContextResult,
    systemInstructions: string
  ): Promise<{
    messages: Array<{ role: string; content: string }>;
    latestUserQuery: string | null;
  }> {
    const { recentValidMessages, latestUserMessage } =
      this.getRecentValidMessages(context.conversationContext, 10);

    const messages = [];
    messages.push({ role: "system", content: systemInstructions });

    messages.push(
      ...recentValidMessages.map((msg) => ({
        role: this.mapRoleToN8n(msg.role),
        content: msg.content || "",
      }))
    );

    return {
      messages,
      latestUserQuery: latestUserMessage?.content || null,
    };
  }

  private getRecentValidMessages(
    conversationContext:
      | Array<Message | { role: MessageRole; content: string }>
      | undefined,
    limit: number
  ): { recentValidMessages: Message[]; latestUserMessage: Message | null } {
    if (!conversationContext)
      return { recentValidMessages: [], latestUserMessage: null };

    const validMessages = conversationContext
      .filter((msg) => {
        const isValid = msg.content && msg.role;
        if (!isValid) {
          this.logger.warn("Mensaje inválido en contexto:", msg);
        }
        return isValid;
      })
      .map((msg) => ({
        ...msg,
        content: msg.content || "",
        role: msg.role,
      })) as Message[];

    let latestUserMessage: Message | null = null;
    for (let i = validMessages.length - 1; i >= 0; i--) {
      if (validMessages[i].role === MessageRole.USER) {
        latestUserMessage = validMessages[i];
        break;
      }
    }

    const recentValidMessages = validMessages.slice(-limit);
    return { recentValidMessages, latestUserMessage };
  }

  private mapRoleToN8n(role: MessageRole): string {
    switch (role) {
      case MessageRole.SYSTEM:
        return "system";
      case MessageRole.ASSISTANT:
        return "assistant";
      case MessageRole.USER:
        return "user";
      default:
        return "user";
    }
  }

  private async saveAssistantMessage(
    conversationId: string,
    agentId: string,
    content: string,
    responseTime: number,
    status: MessageStatus = MessageStatus.SENT
  ): Promise<string> {
    const messageId = uuidv4();
    const now = Date.now();
    const newMessage: Message = {
      id: messageId,
      conversationId,
      content,
      role: MessageRole.ASSISTANT,
      senderId: agentId,
      timestamp: now,
      responseTime,
      status,
      messageType: MessageType.TEXT,
      createdAt: now,
    };

    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.MESSAGES
      );
      await tableClient.createEntity({
        partitionKey: conversationId,
        rowKey: messageId,
        ...newMessage,
        attachments: undefined,
        metadata: undefined,
        errorMessage:
          status === MessageStatus.FAILED
            ? content.substring(0, 1024)
            : undefined,
      });
      this.logger.debug(
        `Mensaje del asistente ${messageId} guardado en DB (${status}).`
      );
      return messageId;
    } catch (error) {
      this.logger.error(
        `Error al guardar mensaje del asistente ${messageId}:`,
        error
      );
      throw error;
    }
  }

  private async queueForSending(
    conversationId: string,
    messageId: string,
    agentId: string,
    userId: string
  ): Promise<void> {
    try {
      const queueClient = this.storageService.getQueueClient("message-queue");
      const message = {
        messageId,
        conversationId,
        agentId,
        userId,
      };
      await queueClient.sendMessage(
        Buffer.from(JSON.stringify(message)).toString("base64")
      );
      this.logger.debug(`Mensaje ${messageId} encolado para envío`);
    } catch (error) {
      this.logger.error(
        `Error al encolar mensaje ${messageId} para envío:`,
        error
      );
      throw createAppError(500, "Error al encolar para envío");
    }
  }
}
