import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { CosmosService } from "../../services/cosmos.service";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import {
  QuestionnaireSubmission,
  QuestionnaireSubmissionCreateRequest,
  QuestionnaireSubmissionUpdateRequest,
  QuestionnaireSubmissionSearchParams,
} from "../../models/questionnaireSubmission.model";
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

  // Main entry point for all questionnaire operations
  async execute(data: any, method: string, id?: string): Promise<any> {
    try {
      switch (method) {
        case "POST":
          return await this.createQuestionnaireSubmission(data);

        case "GET":
          return await this.listQuestionnaireSubmissions(data);

        case "PUT":
          if (!id) {
            throw createAppError(
              400,
              "Questionnaire ID is required for update"
            );
          }
          return await this.updateQuestionnaireSubmission(id, data);

        case "DELETE":
          if (!id) {
            throw createAppError(
              400,
              "Questionnaire ID is required for deletion"
            );
          }
          return await this.deleteQuestionnaireSubmission(id);

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

      const items =
        await this.cosmosService.queryItems<QuestionnaireSubmission>(
          this.CONTAINER_NAME,
          query,
          queryParams
        );

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

      const questionnaireSubmission: QuestionnaireSubmission = {
        id,
        userId: data.userId,
        agentId: data.agentId,
        questionnaireAnswers: data.questionnaireAnswers,
        status: data.status || "draft",
        createdAt: now,
        updatedAt: now,
        _partitionKey: id, // Partition key must match the id for Cosmos DB
      };

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

  private async updateQuestionnaireSubmission(
    id: string,
    data: QuestionnaireSubmissionUpdateRequest
  ): Promise<QuestionnaireSubmission> {
    try {
      const existingQuestionnaire =
        await this.cosmosService.getItem<QuestionnaireSubmission>(
          this.CONTAINER_NAME,
          id,
          id
        );

      if (!existingQuestionnaire) {
        throw createAppError(404, "Questionnaire not found");
      }

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

  private async deleteQuestionnaireSubmission(id: string): Promise<void> {
    try {
      const entity = await this.cosmosService.getItem<QuestionnaireSubmission>(
        this.CONTAINER_NAME,
        id,
        id
      );

      if (!entity) {
        throw createAppError(404, "Questionnaire not found");
      }

      await this.cosmosService.deleteItem(this.CONTAINER_NAME, id, id);
    } catch (error) {
      throw error;
    }
  }
}
