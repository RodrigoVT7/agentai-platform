import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { StorageService } from "../../services/storage.service";
import { ValidationResult } from "../../models/validation.model";
import {
  QuestionnaireSubmissionCreateRequest,
  QuestionnaireSubmissionUpdateRequest,
  QuestionnaireSubmissionSubmitRequest,
  QuestionnaireSubmission,
  QuestionnaireSubmissionEntity,
} from "../../models/questionnaireSubmission.model";
import { STORAGE_TABLES } from "../../constants";
import { TableClient } from "@azure/data-tables";

const VALID_DRAFT_STATUSES = ["draft", "ready"] as const;
const VALID_UPDATE_STATUSES = [...VALID_DRAFT_STATUSES, "completed"] as const;

export class QuestionnaireSubmissionValidator {
  private storageService: StorageService;
  private logger: Logger;
  private readonly TABLE_NAME = "questionnairesubmissions"; // Nombre explícito para evitar problemas

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  // Método específico para obtener TableClient
  private getTableClient(tableName: string): TableClient {
    const connectionString = process.env.STORAGE_CONNECTION_STRING || "";
    return TableClient.fromConnectionString(connectionString, tableName, {
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

  /**
   * Validates questionnaire creation
   */
  async validateCreate(
    data: QuestionnaireSubmissionCreateRequest,
    userId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    this.validateRequiredFields(data, errors);

    if (data.status && !VALID_DRAFT_STATUSES.includes(data.status)) {
      errors.push("Invalid status");
    }

    if (data.agentId) {
      try {
        const tableClient = this.getTableClient(STORAGE_TABLES.AGENTS);
        const agent = await tableClient.getEntity("agent", data.agentId);

        if (!agent) {
          errors.push("Specified agent does not exist");
        } else if (agent.userId !== userId) {
          errors.push(
            "Only the agent owner can create a questionnaire response"
          );
        }
      } catch (error: any) {
        if (error.statusCode === 404) {
          errors.push("Specified agent does not exist");
        } else {
          this.logger.error(`Error checking agent ${data.agentId}:`, error);
          errors.push("Error validating agent access");
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates questionnaire update
   */
  async validateUpdate(
    userId: string,
    agentId: string,
    data: QuestionnaireSubmissionUpdateRequest
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    if (data.questionnaireAnswers === undefined && data.status === undefined) {
      errors.push("At least one field is required for update");
    }

    if (data.status && !VALID_UPDATE_STATUSES.includes(data.status)) {
      errors.push("Invalid status");
    }

    const questionnaire = await this.getQuestionnaire(userId, agentId);
    if (!questionnaire) {
      errors.push("Questionnaire not found");
    } else {
      const hasAccess = await this.verifyAgentAccess(
        questionnaire.agentId,
        userId
      );
      if (!hasAccess) {
        errors.push("No access to the specified agent");
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates questionnaire submission
   */
  async validateSubmit(
    data: QuestionnaireSubmissionSubmitRequest,
    userId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!data.questionnaireSubmissionId) {
      errors.push("Questionnaire ID is required");
    }

    if (!data.answers || Object.keys(data.answers).length === 0) {
      errors.push("Answers are required to submit");
    }

    if (data.questionnaireSubmissionId) {
      // El ID debe estar en formato userId__agentId
      const [qUserId, qAgentId] = data.questionnaireSubmissionId.split("__");

      if (!qUserId || !qAgentId) {
        errors.push("Invalid questionnaire ID format");
        return {
          isValid: false,
          errors,
        };
      }

      const questionnaire = await this.getQuestionnaire(qUserId, qAgentId);
      if (!questionnaire) {
        errors.push("Questionnaire not found");
      } else {
        const hasAccess = await this.verifyAgentAccess(
          questionnaire.agentId,
          userId
        );
        if (!hasAccess) {
          errors.push("No access to the specified agent");
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validates required fields for questionnaire creation
   */
  private validateRequiredFields(
    data: QuestionnaireSubmissionCreateRequest,
    errors: string[]
  ): void {
    if (!data.agentId) {
      errors.push("Agent ID is required");
    }

    if (!data.userId) {
      errors.push("User ID is required");
    }

    if (!data.questionnaireAnswers) {
      errors.push("Questionnaire answers are required");
    }
  }

  /**
   * Gets a questionnaire by ID
   */
  private async getQuestionnaire(
    userId: string,
    agentId: string
  ): Promise<QuestionnaireSubmission | null> {
    try {
      const tableClient = this.getTableClient(this.TABLE_NAME);

      // Sanitizar claves
      const partitionKey = this.sanitizeKey(userId);
      const rowKey = this.sanitizeKey(agentId);

      const entity = await tableClient.getEntity<QuestionnaireSubmissionEntity>(
        partitionKey,
        rowKey
      );

      if (!entity) return null;

      // Convertir a modelo QuestionnaireSubmission
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
    } catch (error: any) {
      if (error.statusCode === 404) {
        return null;
      }
      this.logger.error(
        `Error getting questionnaire for user ${userId} and agent ${agentId}:`,
        error
      );
      return null;
    }
  }

  /**
   * Verifies user access to an agent
   */
  private async verifyAgentAccess(
    agentId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const tableClient = this.getTableClient(STORAGE_TABLES.AGENTS);

      try {
        const agent = await tableClient.getEntity("agent", agentId);
        if (agent.userId === userId) {
          return true;
        }
      } catch (error: any) {
        if (error.statusCode !== 404) {
          this.logger.error(`Error checking agent ${agentId}:`, error);
        }
        return false;
      }

      // Verificar roles de usuario
      const rolesTableClient = this.getTableClient(STORAGE_TABLES.USER_ROLES);
      const odataFilter = `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true`;

      const roles = [];
      const rolesIterator = rolesTableClient.listEntities({
        queryOptions: { filter: odataFilter },
      });

      for await (const role of rolesIterator) {
        roles.push(role);
      }

      return roles.length > 0;
    } catch (error) {
      this.logger.error(
        `Error verifying access for user ${userId} to agent ${agentId}:`,
        error
      );
      return false;
    }
  }
}
