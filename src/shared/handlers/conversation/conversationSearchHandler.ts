// src/shared/handlers/conversation/conversationSearchHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { ConversationSearchParams } from "../../validators/conversation/conversationSearchValidator";
import { Conversation, Message } from "../../models/conversation.model";

interface SearchResult {
  conversations: Conversation[];
  total: number;
  limit: number;
  skip: number;
}

export class ConversationSearchHandler {
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  async execute(
    searchParams: ConversationSearchParams,
    userId: string
  ): Promise<SearchResult> {
    try {
      // Establecer valores predeterminados
      const limit = searchParams.limit || 10;
      const skip = searchParams.skip || 0;

      // 1. Verificar acceso al agente (si se proporciona)
      if (searchParams.agentId) {
        const hasAccess = await this.verifyAgentAccess(
          searchParams.agentId,
          userId
        );

        if (!hasAccess) {
          throw createAppError(
            403,
            "No tienes permiso para acceder a este agente"
          );
        }
      }

      // 2. Buscar conversaciones que coincidan con los criterios
      let conversations = await this.findConversations(searchParams, userId);

      // 3. Si hay consulta de texto, filtrar por contenido de mensajes
      if (searchParams.query) {
        conversations = await this.filterConversationsByMessageContent(
          conversations,
          searchParams.query
        );
      }

      // 4. Ordenar por fecha de actualización (más reciente primero)
      conversations.sort((a, b) => b.updatedAt - a.updatedAt);

      // 5. Aplicar paginación
      const paginatedConversations = conversations.slice(skip, skip + limit);

      // 6. Enriquecer con información adicional
      const enrichedConversations = await this.enrichConversations(
        paginatedConversations
      );

      return {
        conversations: enrichedConversations,
        total: conversations.length,
        limit,
        skip,
      };
    } catch (error) {
      this.logger.error(`Error al buscar conversaciones:`, error);

      if (error && typeof error === "object" && "statusCode" in error) {
        throw error;
      }

      throw createAppError(500, "Error al buscar conversaciones");
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

  private async findConversations(
    searchParams: ConversationSearchParams,
    userId: string
  ): Promise<Conversation[]> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.CONVERSATIONS
      );

      // Construir filtro base
      let filter = "";

      // Filtrar por agente o por usuario
      if (searchParams.agentId) {
        filter = `PartitionKey eq '${searchParams.agentId}'`;
      } else {
        // Si no se especifica un agente, mostrar solo las conversaciones del usuario
        filter = `userId eq '${userId}'`;
      }

      // Añadir filtros adicionales
      if (searchParams.status) {
        filter += ` and status eq '${searchParams.status}'`;
      }

      if (searchParams.startDate) {
        filter += ` and startDate ge ${searchParams.startDate}`;
      }

      if (searchParams.endDate) {
        filter += ` and startDate le ${searchParams.endDate}`;
      }

      // Obtener conversaciones
      const conversations: Conversation[] = [];
      const conversationsEntities = await tableClient.listEntities({
        queryOptions: { filter },
      });

      for await (const entity of conversationsEntities) {
        // Verificar acceso (si no se filtró por agentId)
        if (!searchParams.agentId) {
          // Si el usuario no es propietario, verificar acceso al agente
          if (entity.userId !== userId) {
            const hasAccess = await this.verifyAgentAccess(
              entity.agentId as string,
              userId
            );
            if (!hasAccess) continue;
          }
        }

        conversations.push(entity as unknown as Conversation);
      }

      return conversations;
    } catch (error) {
      this.logger.error(`Error al buscar conversaciones:`, error);
      return [];
    }
  }

  private async filterConversationsByMessageContent(
    conversations: Conversation[],
    query: string
  ): Promise<Conversation[]> {
    try {
      if (conversations.length === 0) return [];

      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.MESSAGES
      );
      const filteredConversationIds = new Set<string>();

      // Buscar mensajes que contengan la consulta
      for (const conversation of conversations) {
        const messages = await tableClient.listEntities({
          queryOptions: { filter: `PartitionKey eq '${conversation.id}'` },
        });

        for await (const message of messages) {
          const content = message.content as string;

          if (content && content.toLowerCase().includes(query.toLowerCase())) {
            filteredConversationIds.add(conversation.id);
            break; // Encontramos una coincidencia, pasar a la siguiente conversación
          }
        }
      }

      // Filtrar conversaciones
      return conversations.filter((conv) =>
        filteredConversationIds.has(conv.id)
      );
    } catch (error) {
      this.logger.error(
        `Error al filtrar conversaciones por contenido:`,
        error
      );
      return conversations; // En caso de error, devolver sin filtrar
    }
  }

  private async enrichConversations(
    conversations: Conversation[]
  ): Promise<Conversation[]> {
    try {
      if (conversations.length === 0) return [];

      const messageTableClient = this.storageService.getTableClient(
        STORAGE_TABLES.MESSAGES
      );
      const enriched: Conversation[] = [];

      for (const conversation of conversations) {
        // Contar mensajes
        let messageCount = 0;
        const messages = await messageTableClient.listEntities({
          queryOptions: { filter: `PartitionKey eq '${conversation.id}'` },
        });

        for await (const message of messages) {
          messageCount++;
        }

        // Añadir información adicional
        enriched.push({
          ...conversation,
          messageCount,
          lastUpdated: conversation.updatedAt,
        } as any);
      }

      return enriched;
    } catch (error) {
      this.logger.error(`Error al enriquecer conversaciones:`, error);
      return conversations; // En caso de error, devolver sin enriquecer
    }
  }
}
