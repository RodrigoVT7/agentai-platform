import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import {
  QuestionnaireSubmission,
  QuestionnaireSubmissionResponse,
  QuestionnaireSubmissionCreateRequest,
  QuestionnaireSubmissionUpdateRequest,
  QuestionnaireSubmissionSubmitRequest,
  QuestionnaireSubmissionSearchParams,
  Question,
  QuestionType,
  Answer,
} from "../../models/questionnaireSubmission.model";

export class QuestionnaireSubmissionHandler {
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  /**
   * Ejecuta la operación solicitada en el cuestionario
   */
  async execute(data: any, method: string, id?: string): Promise<any> {
    try {
      switch (method) {
        case "GET":
          return id
            ? await this.getQuestionnaireSubmission(id)
            : await this.listQuestionnaireSubmissions(data);

        case "POST":
          return await this.createQuestionnaireSubmission(data);

        case "PUT":
          if (!id) {
            throw createAppError(
              400,
              "Se requiere ID del cuestionario para actualizar"
            );
          }
          return await this.updateQuestionnaireSubmission(id, data);

        case "DELETE":
          if (!id) {
            throw createAppError(
              400,
              "Se requiere ID del cuestionario para eliminar"
            );
          }
          return await this.deleteQuestionnaireSubmission(id);

        case "SUBMIT":
          return await this.submitQuestionnaireSubmission(data);

        default:
          throw createAppError(400, `Método no soportado: ${method}`);
      }
    } catch (error) {
      this.logger.error(`Error en operación ${method} de cuestionario:`, error);
      throw error;
    }
  }

  /**
   * Obtiene un cuestionario por su ID
   */
  private async getQuestionnaireSubmission(
    id: string
  ): Promise<QuestionnaireSubmission> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.QUESTIONNAIRE_SUBMISSIONS
      );
      const entity = await tableClient.getEntity("questionnaire", id);

      if (!entity) {
        throw createAppError(404, "Cuestionario no encontrado");
      }

      return this.mapEntityToQuestionnaireSubmission(entity);
    } catch (error) {
      this.logger.error("Error al obtener cuestionario:", error);
      throw error;
    }
  }

  /**
   * Lista cuestionarios según los criterios de búsqueda
   */
  private async listQuestionnaireSubmissions(
    params: QuestionnaireSubmissionSearchParams
  ): Promise<{ items: QuestionnaireSubmission[]; count: number }> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.QUESTIONNAIRE_SUBMISSIONS
      );

      // Construir filtro
      let filter = "";

      if (params.agentId) {
        filter = `agentId eq '${params.agentId}'`;
      }

      if (params.userId) {
        const userIdFilter = `userId eq '${params.userId}'`;
        filter = filter ? `${filter} and ${userIdFilter}` : userIdFilter;
      }

      if (params.status) {
        const statusFilter = `status eq '${params.status}'`;
        filter = filter ? `${filter} and ${statusFilter}` : statusFilter;
      }

      // Obtener entidades
      const entities = tableClient.listEntities({
        queryOptions: { filter },
      });

      // Procesar resultados
      const items: QuestionnaireSubmission[] = [];
      let count = 0;

      for await (const entity of entities) {
        items.push(this.mapEntityToQuestionnaireSubmission(entity));
        count++;

        // Aplicar paginación
        if (params.limit && items.length >= params.limit) {
          break;
        }
      }

      return { items, count };
    } catch (error) {
      this.logger.error("Error al listar cuestionarios:", error);
      throw error;
    }
  }

  /**
   * Crea un nuevo cuestionario
   */
  private async createQuestionnaireSubmission(
    data: QuestionnaireSubmissionCreateRequest
  ): Promise<QuestionnaireSubmission> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.QUESTIONNAIRE_SUBMISSIONS
      );

      // Generar ID
      const id = uuidv4();
      const now = new Date().toISOString();

      // Crear entidad
      const questionnaireSubmission: QuestionnaireSubmission = {
        id,
        userId: data.userId,
        agentId: data.agentId,
        questionnaireAnswers: data.questionnaireAnswers,
        status: data.status || "draft",
        createdAt: now,
        updatedAt: now,
      };

      // Guardar en tabla
      await tableClient.createEntity({
        partitionKey: "questionnaire",
        rowKey: id,
        ...questionnaireSubmission,
      });

      return questionnaireSubmission;
    } catch (error) {
      this.logger.error("Error al crear cuestionario:", error);
      throw error;
    }
  }

  /**
   * Actualiza un cuestionario existente
   */
  private async updateQuestionnaireSubmission(
    id: string,
    data: QuestionnaireSubmissionUpdateRequest
  ): Promise<QuestionnaireSubmission> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.QUESTIONNAIRE_SUBMISSIONS
      );

      // Obtener cuestionario existente
      const existingEntity = await tableClient.getEntity("questionnaire", id);

      if (!existingEntity) {
        throw createAppError(404, "Cuestionario no encontrado");
      }

      const existingQuestionnaireSubmission =
        this.mapEntityToQuestionnaireSubmission(existingEntity);

      // Preparar actualización
      const updatedQuestionnaireSubmission: QuestionnaireSubmission = {
        ...existingQuestionnaireSubmission,
        questionnaireAnswers:
          data.questionnaireAnswers !== undefined
            ? data.questionnaireAnswers
            : existingQuestionnaireSubmission.questionnaireAnswers,
        status:
          data.status !== undefined
            ? data.status
            : existingQuestionnaireSubmission.status,
        updatedAt: new Date().toISOString(),
      };

      // Actualizar en tabla
      await tableClient.updateEntity(
        {
          partitionKey: "questionnaire",
          rowKey: id,
          ...updatedQuestionnaireSubmission,
        },
        "Replace"
      );

      return updatedQuestionnaireSubmission;
    } catch (error) {
      this.logger.error("Error al actualizar cuestionario:", error);
      throw error;
    }
  }

  /**
   * Elimina un cuestionario
   */
  private async deleteQuestionnaireSubmission(id: string): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.QUESTIONNAIRE_SUBMISSIONS
      );

      // Verificar que existe
      const entity = await tableClient.getEntity("questionnaire", id);

      if (!entity) {
        throw createAppError(404, "Cuestionario no encontrado");
      }

      // Eliminar
      await tableClient.deleteEntity("questionnaire", id);
    } catch (error) {
      this.logger.error("Error al eliminar cuestionario:", error);
      throw error;
    }
  }

  /**
   * Envía una respuesta a un cuestionario
   */
  private async submitQuestionnaireSubmission(
    request: QuestionnaireSubmissionSubmitRequest
  ): Promise<QuestionnaireSubmissionResponse> {
    const { questionnaireSubmissionId, userId, answers } = request;

    const tableClient = this.storageService.getTableClient(
      STORAGE_TABLES.QUESTIONNAIRE_SUBMISSIONS
    );
    const entity = await tableClient.getEntity(
      "questionnaire",
      questionnaireSubmissionId
    );

    if (!entity) {
      throw new Error(
        `Questionnaire with ID ${questionnaireSubmissionId} not found`
      );
    }

    const questionnaireSubmission =
      this.mapEntityToQuestionnaireSubmission(entity);
    const responseId = uuidv4();
    const now = new Date().toISOString();

    const response: QuestionnaireSubmissionResponse = {
      id: responseId,
      questionnaireSubmissionId,
      userId,
      answers,
      completedAt: Date.now(),
      createdAt: Date.now(),
    };

    const responseEntity = {
      partitionKey: "response",
      rowKey: responseId,
      ...response,
    };

    await this.storageService
      .getTableClient(STORAGE_TABLES.QUESTIONNAIRE_RESPONSES)
      .createEntity(responseEntity);

    return response;
  }

  /**
   * Mapea una entidad de tabla a un objeto QuestionnaireSubmission
   */
  private mapEntityToQuestionnaireSubmission(
    entity: any
  ): QuestionnaireSubmission {
    if (!entity.agentId) {
      throw new Error("La entidad del cuestionario debe tener un agentId");
    }

    if (!entity.userId) {
      throw new Error("La entidad del cuestionario debe tener un userId");
    }

    return {
      id: entity.rowKey,
      userId: entity.userId,
      agentId: entity.agentId,
      questionnaireAnswers: entity.questionnaireAnswers || {},
      status: entity.status || "draft",
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}
