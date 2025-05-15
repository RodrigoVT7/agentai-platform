import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

interface ListOptions {
  limit: number;
  before?: number;
}

export class ConversationsListHandler {
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  async execute(
    agentId: string,
    userId: string,
    options: ListOptions = { limit: 50 }
  ): Promise<any> {
    try {
      // 1. Verificar acceso al agente
      const hasAccess = await this.verifyAgentAccess(agentId, userId);

      if (!hasAccess) {
        throw createAppError(
          403,
          "No tienes permiso para acceder a estas conversaciones"
        );
      }

      // 2. Obtener conversaciones del agente
      const conversations = await this.getAgentConversations(agentId, options);

      // 3. Devolver resultado
      return {
        conversations,
        pagination: {
          limit: options.limit,
          hasMore: conversations.length === options.limit,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error al obtener conversaciones del agente ${agentId}:`,
        error
      );

      if (error && typeof error === "object" && "statusCode" in error) {
        throw error;
      }

      throw createAppError(500, "Error al obtener conversaciones del agente");
    }
  }

  private async verifyAgentAccess(
    agentId: string,
    userId: string
  ): Promise<boolean> {
    try {
      // Verificar si el usuario es propietario del agente
      const agentsTable = this.storageService.getTableClient(
        STORAGE_TABLES.AGENTS
      );

      try {
        const agent = await agentsTable.getEntity("agent", agentId);

        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        return false;
      }

      // Verificar si el usuario tiene algún rol en el agente
      const rolesTable = this.storageService.getTableClient(
        STORAGE_TABLES.USER_ROLES
      );
      const roles = rolesTable.listEntities({
        queryOptions: {
          filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true`,
        },
      });

      for await (const role of roles) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(
        `Error al verificar acceso al agente ${agentId}:`,
        error
      );
      return false;
    }
  }

  private async getAgentConversations(
    agentId: string,
    options: ListOptions
  ): Promise<any[]> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.CONVERSATIONS
      );

      // Construir filtro
      let filter = `agentId eq '${agentId}'`;

      if (options.before) {
        filter += ` and timestamp lt ${options.before}`;
      }

      const conversations: any[] = [];
      const conversationEntities = await tableClient.listEntities({
        queryOptions: { filter },
      });

      for await (const entity of conversationEntities) {
        conversations.push({
          id: entity.RowKey,
          agentId: entity.agentId,
          code: entity.code,
          startDate: entity.startDate,
          endDate: entity.endDate,
          status: entity.status,
          sourceChannel: entity.sourceChannel,
        });
      }

      // Ordenar por timestamp descendente y limitar
      return conversations
        .sort(
          (a, b) =>
            new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
        )
        .slice(0, options.limit);
    } catch (error) {
      this.logger.error(
        `Error al obtener conversaciones del agente ${agentId}:`,
        error
      );
      return [];
    }
  }
}
