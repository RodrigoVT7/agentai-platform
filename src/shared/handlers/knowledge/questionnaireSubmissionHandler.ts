import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { CosmosService } from "../../services/cosmos.service";
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
import { STORAGE_CONTAINERS } from "../../constants";
import { QuestionnaireSubmissionValidator } from "../../validators/knowledge/questionnaireSubmissionValidator";

export class QuestionnaireSubmissionHandler {
  private storageService: StorageService;
  private cosmosService: CosmosService;
  private logger: Logger;
  private readonly CONTAINER_NAME = "questionnaire_submissions";

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.cosmosService = new CosmosService();
    this.logger = logger || createLogger();
  }

  /**
   * Ejecuta la operación solicitada en el cuestionario
   */
  async execute(data: any, method: string, id?: string): Promise<any> {
    try {
      switch (method) {
        case "POST":
          return await this.createQuestionnaireSubmission(data);

        case "GET":
          return id
            ? await this.getQuestionnaireSubmission(id)
            : await this.listQuestionnaireSubmissions(data);

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
      const entity = await this.cosmosService.getItem<QuestionnaireSubmission>(
        this.CONTAINER_NAME,
        id,
        id
      );

      if (!entity) {
        throw createAppError(404, "Cuestionario no encontrado");
      }

      return entity;
    } catch (error) {
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
      // Construir consulta
      let query = "SELECT * FROM c WHERE 1=1";
      const queryParams: any[] = [];

      if (params.agentId) {
        query += " AND c.agentId = @agentId";
        queryParams.push({ name: "@agentId", value: params.agentId });
      }

      if (params.userId) {
        query += " AND c.userId = @userId";
        queryParams.push({ name: "@userId", value: params.userId });
      }

      if (params.status) {
        query += " AND c.status = @status";
        queryParams.push({ name: "@status", value: params.status });
      }

      // Obtener resultados
      const items =
        await this.cosmosService.queryItems<QuestionnaireSubmission>(
          this.CONTAINER_NAME,
          query,
          queryParams
        );

      // Aplicar paginación
      const limit = params.limit || items.length;
      const skip = params.skip || 0;
      const paginatedItems = items.slice(skip, skip + limit);

      return {
        items: paginatedItems,
        count: items.length,
      };
    } catch (error) {
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
      // Validar datos
      const validator = new QuestionnaireSubmissionValidator();
      const validationResult = await validator.validateCreate(
        data,
        data.userId
      );

      if (!validationResult.isValid) {
        throw createAppError(400, "Datos inválidos", validationResult.errors);
      }

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
        _partitionKey: id, // Usar el ID como clave de partición
      };

      // Guardar en Cosmos DB
      const result =
        await this.cosmosService.createItem<QuestionnaireSubmission>(
          this.CONTAINER_NAME,
          questionnaireSubmission
        );

      return result;
    } catch (error) {
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
      // Obtener cuestionario existente
      const existingQuestionnaire =
        await this.cosmosService.getItem<QuestionnaireSubmission>(
          this.CONTAINER_NAME,
          id,
          id
        );

      if (!existingQuestionnaire) {
        throw createAppError(404, "Cuestionario no encontrado");
      }

      // Preparar actualización
      const updatedQuestionnaireSubmission: QuestionnaireSubmission = {
        ...existingQuestionnaire,
        questionnaireAnswers:
          data.questionnaireAnswers !== undefined
            ? data.questionnaireAnswers
            : existingQuestionnaire.questionnaireAnswers,
        status:
          data.status !== undefined
            ? data.status
            : existingQuestionnaire.status,
        updatedAt: new Date().toISOString(),
      };

      // Actualizar en Cosmos DB
      const result =
        await this.cosmosService.updateItem<QuestionnaireSubmission>(
          this.CONTAINER_NAME,
          id,
          id,
          updatedQuestionnaireSubmission
        );

      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Elimina un cuestionario
   */
  private async deleteQuestionnaireSubmission(id: string): Promise<void> {
    try {
      // Verificar que existe
      const entity = await this.cosmosService.getItem<QuestionnaireSubmission>(
        this.CONTAINER_NAME,
        id,
        id
      );

      if (!entity) {
        throw createAppError(404, "Cuestionario no encontrado");
      }

      // Eliminar
      await this.cosmosService.deleteItem(this.CONTAINER_NAME, id, id);
    } catch (error) {
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

    const questionnaire =
      await this.cosmosService.getItem<QuestionnaireSubmission>(
        this.CONTAINER_NAME,
        questionnaireSubmissionId,
        questionnaireSubmissionId
      );

    if (!questionnaire) {
      throw new Error(
        `Questionnaire with ID ${questionnaireSubmissionId} not found`
      );
    }

    const responseId = uuidv4();
    const now = new Date().toISOString();

    const response: QuestionnaireSubmissionResponse = {
      id: responseId,
      questionnaireSubmissionId,
      userId,
      answers,
      completedAt: Date.now(),
      createdAt: Date.now(),
      _partitionKey: responseId, // Usar el ID como clave de partición
    };

    // Guardar respuesta en Cosmos DB
    await this.cosmosService.createItem<QuestionnaireSubmissionResponse>(
      STORAGE_CONTAINERS.QUESTIONNAIRE_RESPONSES,
      response
    );

    return response;
  }
}
