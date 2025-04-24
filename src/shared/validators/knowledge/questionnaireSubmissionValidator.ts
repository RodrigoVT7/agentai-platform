import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { CosmosService } from "../../services/cosmos.service";
import { StorageService } from "../../services/storage.service";
import { ValidationResult } from "../../models/validation.model";
import {
  QuestionnaireSubmissionCreateRequest,
  QuestionnaireSubmissionUpdateRequest,
  QuestionnaireSubmissionSubmitRequest,
  QuestionnaireSubmission,
} from "../../models/questionnaireSubmission.model";
import { STORAGE_TABLES, STORAGE_CONTAINERS } from "../../constants";

const VALID_DRAFT_STATUSES = ["draft", "ready"] as const;
const VALID_UPDATE_STATUSES = [...VALID_DRAFT_STATUSES, "completed"] as const;

export class QuestionnaireSubmissionValidator {
  private cosmosService: CosmosService;
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.cosmosService = new CosmosService();
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
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
        const tableClient = this.storageService.getTableClient(
          STORAGE_TABLES.AGENTS
        );
        const agent = await tableClient.getEntity("agent", data.agentId);

        if (!agent) {
          errors.push("Specified agent does not exist");
        } else if (agent.userId !== userId) {
          errors.push(
            "Only the agent owner can create a questionnaire response"
          );
        }
      } catch (error) {
        this.logger.error(`Error checking agent ${data.agentId}:`, error);
        errors.push("Specified agent does not exist");
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
    id: string,
    data: QuestionnaireSubmissionUpdateRequest,
    userId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    if (data.questionnaireAnswers === undefined && data.status === undefined) {
      errors.push("At least one field is required for update");
    }

    if (data.status && !VALID_UPDATE_STATUSES.includes(data.status)) {
      errors.push("Invalid status");
    }

    const questionnaire = await this.getQuestionnaire(id);
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
      const questionnaire = await this.getQuestionnaire(
        data.questionnaireSubmissionId
      );
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
    id: string
  ): Promise<QuestionnaireSubmission | null> {
    try {
      return await this.cosmosService.getItem<QuestionnaireSubmission>(
        STORAGE_CONTAINERS.QUESTIONNAIRE_SUBMISSIONS,
        id,
        id
      );
    } catch (error) {
      this.logger.error(`Error getting questionnaire ${id}:`, error);
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
      const agent = await this.cosmosService.getItem(
        STORAGE_TABLES.AGENTS,
        agentId,
        agentId
      );

      if (agent && agent.userId === userId) {
        return true;
      }

      const roles = await this.cosmosService.queryItems(
        STORAGE_TABLES.USER_ROLES,
        "SELECT * FROM c WHERE c.agentId = @agentId AND c.userId = @userId AND c.isActive = true",
        [
          { name: "@agentId", value: agentId },
          { name: "@userId", value: userId },
        ]
      );

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
