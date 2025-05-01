import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import {
  QuestionnaireSubmission,
  QuestionnaireSubmissionCreateRequest,
  QuestionnaireSubmissionUpdateRequest,
  QuestionnaireSubmissionSearchParams,
  QuestionnaireSubmissionEntity,
} from "../../models/questionnaireSubmission.model";
import { QuestionnaireSubmissionValidator } from "../../validators/knowledge/questionnaireSubmissionValidator";
import { STORAGE_TABLES } from "../../constants";
import {
  TableClient,
  odata,
  ListTableEntitiesOptions,
} from "@azure/data-tables";

export class QuestionnaireSubmissionHandler {
  private storageService: StorageService;
  private logger: Logger;
  private readonly TABLE_NAME = "questionnairesubmissions";

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  // Método específico para obtener TableClient
  // Esto nos permite controlar directamente el nombre de la tabla
  private getTableClient(): TableClient {
    // Usar el connectionString directamente para evitar problemas con la lógica de resolución de nombres
    const connectionString = process.env.STORAGE_CONNECTION_STRING || "";
    return TableClient.fromConnectionString(connectionString, this.TABLE_NAME, {
      allowInsecureConnection: true,
    });
  }

  // Función para sanitizar claves para Azure Table Storage
  private sanitizeKey(key: string): string {
    // Eliminar caracteres no permitidos en Azure Table Storage
    return key
      .replace(/[\/\\#?]/g, "_")
      .replace(/\u0000-\u001F/g, "") // Eliminar caracteres de control
      .replace(/\s+/g, "_"); // Reemplazar espacios con guiones bajos
  }

  // Main entry point for all questionnaire operations
  async execute(data: any, method: string, id?: string): Promise<any> {
    try {
      switch (method) {
        case "POST":
          return await this.createQuestionnaireSubmission(data);

        case "GET":
          if (id) {
            // Si hay un ID, recuperar un cuestionario específico
            const [userId, agentId] = id.split("__");
            if (userId && agentId) {
              return await this.getQuestionnaireSubmission(userId, agentId);
            } else {
              // Asumimos que el ID sólo es el agentId
              return await this.getQuestionnaireSubmissionByAgentId(id);
            }
          } else {
            // Si no hay ID, listar cuestionarios con filtros
            return await this.listQuestionnaireSubmissions(data);
          }

        case "PUT":
          if (!id) {
            throw createAppError(
              400,
              "Questionnaire ID is required for update"
            );
          }
          // El ID debe ser en formato userId__agentId
          const [userId, agentId] = id.split("__");
          if (!userId || !agentId) {
            throw createAppError(
              400,
              "Invalid ID format. Expected format: userId__agentId"
            );
          }
          return await this.updateQuestionnaireSubmission(
            userId,
            agentId,
            data
          );

        case "DELETE":
          if (!id) {
            throw createAppError(
              400,
              "Questionnaire ID is required for deletion"
            );
          }
          // El ID debe ser en formato userId__agentId
          const [deleteUserId, deleteAgentId] = id.split("__");
          if (!deleteUserId || !deleteAgentId) {
            throw createAppError(
              400,
              "Invalid ID format. Expected format: userId__agentId"
            );
          }
          await this.deleteQuestionnaireSubmission(deleteUserId, deleteAgentId);
          return { success: true };

        default:
          throw createAppError(400, `Unsupported method: ${method}`);
      }
    } catch (error) {
      throw error;
    }
  }

  private async listQuestionnaireSubmissions(
    params: QuestionnaireSubmissionSearchParams
  ): Promise<{ items: QuestionnaireSubmission[]; count: number }> {
    try {
      const tableClient = this.getTableClient();

      // Construir el filtro OData según los parámetros
      let odataFilter = "";

      if (params.userId) {
        odataFilter = `PartitionKey eq '${params.userId}'`;
      }

      if (params.agentId) {
        if (odataFilter) {
          odataFilter += ` and agentId eq '${params.agentId}'`;
        } else {
          odataFilter = `agentId eq '${params.agentId}'`;
        }
      }

      if (params.status) {
        if (odataFilter) {
          odataFilter += ` and status eq '${params.status}'`;
        } else {
          odataFilter = `status eq '${params.status}'`;
        }
      }

      // Lista para almacenar los resultados
      const entities: QuestionnaireSubmissionEntity[] = [];

      // Consultar entidades
      const queryOptions: ListTableEntitiesOptions = odataFilter
        ? { queryOptions: { filter: odataFilter } }
        : {};
      const iterator =
        tableClient.listEntities<QuestionnaireSubmissionEntity>(queryOptions);

      // Obtener todos los resultados
      for await (const entity of iterator) {
        entities.push(entity);
      }

      // Paginación en memoria
      const limit = params.limit || entities.length;
      const skip = params.skip || 0;
      const paginatedEntities = entities.slice(skip, skip + limit);

      // Convertir entidades a QuestionnaireSubmission
      const items = paginatedEntities.map((entity) =>
        this.mapEntityToQuestionnaireSubmission(entity)
      );

      return {
        items,
        count: entities.length,
      };
    } catch (error) {
      this.logger.error("Error listing questionnaire submissions:", error);
      throw error;
    }
  }

  // Recupera un cuestionario específico por userId y agentId
  private async getQuestionnaireSubmission(
    userId: string,
    agentId: string
  ): Promise<QuestionnaireSubmission> {
    try {
      const tableClient = this.getTableClient();
      // Sanitizar claves
      const partitionKey = this.sanitizeKey(userId);
      const rowKey = this.sanitizeKey(agentId);

      const entity = await tableClient.getEntity<QuestionnaireSubmissionEntity>(
        partitionKey,
        rowKey
      );
      return this.mapEntityToQuestionnaireSubmission(entity);
    } catch (error: any) {
      if (error.statusCode === 404) {
        throw createAppError(404, "Questionnaire not found");
      }
      this.logger.error(
        `Error getting questionnaire for user ${userId} and agent ${agentId}:`,
        error
      );
      throw error;
    }
  }

  // Recupera cuestionarios por agentId
  private async getQuestionnaireSubmissionByAgentId(
    agentId: string
  ): Promise<{ items: QuestionnaireSubmission[] }> {
    try {
      const tableClient = this.getTableClient();
      const odataFilter = `agentId eq '${agentId}'`;

      const entities: QuestionnaireSubmissionEntity[] = [];
      const iterator = tableClient.listEntities<QuestionnaireSubmissionEntity>({
        queryOptions: { filter: odataFilter },
      });

      for await (const entity of iterator) {
        entities.push(entity);
      }

      if (entities.length === 0) {
        throw createAppError(404, "No questionnaires found for this agent");
      }

      return {
        items: entities.map((entity) =>
          this.mapEntityToQuestionnaireSubmission(entity)
        ),
      };
    } catch (error) {
      this.logger.error(
        `Error getting questionnaires for agent ${agentId}:`,
        error
      );
      throw error;
    }
  }

  // Creates a new questionnaire submission with validation
  private async createQuestionnaireSubmission(
    data: QuestionnaireSubmissionCreateRequest
  ): Promise<QuestionnaireSubmission> {
    try {
      const validator = new QuestionnaireSubmissionValidator();
      const validationResult = await validator.validateCreate(
        data,
        data.userId
      );

      if (!validationResult.isValid) {
        throw createAppError(400, "Invalid data", validationResult.errors);
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      // Extraer agentName si está presente en questionnaireAnswers
      const agentName = data.questionnaireAnswers.agent_name || "";

      // Sanitizar userId y agentId para partitionKey y rowKey
      const partitionKey = this.sanitizeKey(data.userId);
      const rowKey = this.sanitizeKey(data.agentId);

      // Crear entidad para Azure Table Storage
      const entity: QuestionnaireSubmissionEntity = {
        partitionKey,
        rowKey,
        id,
        userId: data.userId,
        agentId: data.agentId,
        status: data.status || "draft",
        questionnaireAnswersJson: JSON.stringify(data.questionnaireAnswers),
        agentName,
        createdAt: now,
        updatedAt: now,
      };

      const tableClient = this.getTableClient();
      await tableClient.createEntity(entity);

      // Convertir y devolver
      return this.mapEntityToQuestionnaireSubmission(entity);
    } catch (error) {
      this.logger.error("Error creating questionnaire submission:", error);
      throw error;
    }
  }

  private async updateQuestionnaireSubmission(
    userId: string,
    agentId: string,
    data: QuestionnaireSubmissionUpdateRequest
  ): Promise<QuestionnaireSubmission> {
    try {
      const tableClient = this.getTableClient();

      // Sanitizar claves
      const partitionKey = this.sanitizeKey(userId);
      const rowKey = this.sanitizeKey(agentId);

      // Verificar si existe
      let existingEntity: QuestionnaireSubmissionEntity;
      try {
        existingEntity =
          await tableClient.getEntity<QuestionnaireSubmissionEntity>(
            partitionKey,
            rowKey
          );
      } catch (error: any) {
        if (error.statusCode === 404) {
          throw createAppError(404, "Questionnaire not found");
        }
        throw error;
      }

      // Preparar actualización
      const updatedEntity: QuestionnaireSubmissionEntity = {
        ...existingEntity,
      };

      // Actualizar campos si se proporcionan
      if (data.questionnaireAnswers !== undefined) {
        updatedEntity.questionnaireAnswersJson = JSON.stringify(
          data.questionnaireAnswers
        );

        // Actualizar agentName si está disponible
        const answers = data.questionnaireAnswers;
        if (answers.agent_name) {
          updatedEntity.agentName = answers.agent_name;
        }
      }

      if (data.status !== undefined) {
        updatedEntity.status = data.status;
      }

      updatedEntity.updatedAt = new Date().toISOString();

      // Realizar actualización
      await tableClient.updateEntity(updatedEntity, "Merge");

      // Recuperar entidad actualizada
      const updated =
        await tableClient.getEntity<QuestionnaireSubmissionEntity>(
          partitionKey,
          rowKey
        );

      return this.mapEntityToQuestionnaireSubmission(updated);
    } catch (error) {
      this.logger.error(
        `Error updating questionnaire for user ${userId} and agent ${agentId}:`,
        error
      );
      throw error;
    }
  }

  private async deleteQuestionnaireSubmission(
    userId: string,
    agentId: string
  ): Promise<void> {
    try {
      const tableClient = this.getTableClient();

      // Sanitizar claves
      const partitionKey = this.sanitizeKey(userId);
      const rowKey = this.sanitizeKey(agentId);

      // Verificar si existe
      try {
        await tableClient.getEntity(partitionKey, rowKey);
      } catch (error: any) {
        if (error.statusCode === 404) {
          throw createAppError(404, "Questionnaire not found");
        }
        throw error;
      }

      // Eliminar entidad
      await tableClient.deleteEntity(partitionKey, rowKey);
    } catch (error) {
      this.logger.error(
        `Error deleting questionnaire for user ${userId} and agent ${agentId}:`,
        error
      );
      throw error;
    }
  }

  // Mapea una entidad de Table Storage al modelo QuestionnaireSubmission
  private mapEntityToQuestionnaireSubmission(
    entity: QuestionnaireSubmissionEntity
  ): QuestionnaireSubmission {
    const questionnaireAnswers = JSON.parse(entity.questionnaireAnswersJson);

    return {
      id: entity.id,
      userId: entity.userId,
      agentId: entity.agentId,
      status: entity.status as "draft" | "ready",
      questionnaireAnswersJson: entity.questionnaireAnswersJson,
      agentName: entity.agentName,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      partitionKey: entity.partitionKey,
      rowKey: entity.rowKey,
    };
  }
}
