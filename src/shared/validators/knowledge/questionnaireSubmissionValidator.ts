import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { StorageService } from "../../services/storage.service";
import { ValidationResult } from "../../models/validation.model";
import { STORAGE_TABLES } from "../../constants";
import {
  QuestionnaireSubmissionCreateRequest,
  QuestionnaireSubmissionUpdateRequest,
  QuestionnaireSubmissionSubmitRequest,
} from "../../models/questionnaireSubmission.model";

export class QuestionnaireSubmissionValidator {
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  /**
   * Valida la creación de un cuestionario
   */
  async validateCreate(
    data: QuestionnaireSubmissionCreateRequest,
    userId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    // Validar campos requeridos
    if (!data.agentId) {
      errors.push("El ID del agente es requerido");
    }

    if (!data.userId) {
      errors.push("El ID del usuario es requerido");
    }

    if (!data.questionnaireAnswers) {
      errors.push("Las respuestas del cuestionario son requeridas");
    }

    // Verificar acceso al agente
    if (data.agentId) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("No tiene acceso al agente especificado");
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Valida la actualización de un cuestionario
   */
  async validateUpdate(
    id: string,
    data: QuestionnaireSubmissionUpdateRequest,
    userId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    // Validar campos requeridos
    if (data.questionnaireAnswers === undefined && data.status === undefined) {
      errors.push("Se requiere al menos un campo para actualizar");
    }

    if (data.status && !["draft", "ready", "completed"].includes(data.status)) {
      errors.push("Estado inválido");
    }

    // Verificar acceso al cuestionario
    const hasAccess = await this.verifyQuestionnaireSubmissionAccess(
      id,
      userId
    );
    if (!hasAccess) {
      errors.push("No tiene acceso al cuestionario especificado");
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Valida el envío de respuestas a un cuestionario
   */
  async validateSubmit(
    data: QuestionnaireSubmissionSubmitRequest,
    userId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    // Validar campos requeridos
    if (!data.questionnaireSubmissionId) {
      errors.push("El ID del cuestionario es requerido");
    }

    if (!data.answers || Object.keys(data.answers).length === 0) {
      errors.push("Se requieren respuestas para enviar");
    }

    // Verificar acceso al cuestionario
    if (data.questionnaireSubmissionId) {
      const hasAccess = await this.verifyQuestionnaireSubmissionAccess(
        data.questionnaireSubmissionId,
        userId
      );
      if (!hasAccess) {
        errors.push("No tiene acceso al cuestionario especificado");
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Verifica el acceso de un usuario a un agente
   */
  private async verifyAgentAccess(
    agentId: string,
    userId: string
  ): Promise<boolean> {
    try {
      // TODO: Implementar verificación de acceso al agente
      return true;
    } catch (error) {
      this.logger.error("Error al verificar acceso al agente:", error);
      return false;
    }
  }

  /**
   * Verifica el acceso de un usuario a un cuestionario
   */
  private async verifyQuestionnaireSubmissionAccess(
    questionnaireSubmissionId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.QUESTIONNAIRE_SUBMISSIONS
      );
      const entity = await tableClient.getEntity(
        "questionnaire",
        questionnaireSubmissionId
      );

      if (!entity) {
        return false;
      }

      return entity.userId === userId;
    } catch (error) {
      this.logger.error("Error al verificar acceso al cuestionario:", error);
      return false;
    }
  }
}
