// src/shared/validators/integrations/whatsAppIntegrationValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { HandleWhatsAppEmbeddedSignupInput } from "../../models/meta.model"; // Make sure this path is correct

export class WhatsAppIntegrationValidator {
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  async validateEmbeddedSignupData(
    data: HandleWhatsAppEmbeddedSignupInput,
    userId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!data.esIntegrationCode) {
      errors.push("Authorization code (esIntegrationCode) is required");
    }

    if (!data.agentId) {
      errors.push("Agent ID is required");
    }

    if (!data.phoneNumberId) {
      errors.push("Phone number ID is required");
    }

    if (!data.whatsAppBusinessAccountId) {
      errors.push("WhatsApp Business Account ID is required");
    }

    if (!data.businessId) {
      errors.push("Business ID is required");
    }

    // Environment variables checks are for the handler/service layer, not directly for client input validation.
    // However, if their absence would make processing fail, it's good to include a warning or check upstream.
    // For now, removing from client input validation to keep it focused on client-provided data.

    if (errors.length === 0 && data.agentId) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("You don't have permission to configure this agent");
      }
    }

    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async validateConfig(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];

    // Validar campos requeridos
    if (!data.agentId) {
      errors.push("ID del agente es requerido");
    }

    if (!data.phoneNumberId) {
      errors.push("ID del número de teléfono es requerido");
    }

    if (!data.businessAccountId) {
      errors.push("ID de la cuenta de negocio es requerido");
    }

    if (!data.accessToken) {
      errors.push("Token de acceso es requerido");
    }

    if (!data.phoneNumber) {
      errors.push("Número de teléfono es requerido");
    } else if (!this.isValidPhoneNumber(data.phoneNumber)) {
      errors.push("Formato de número de teléfono inválido");
    }

    // Verificar acceso al agente si no hay errores
    if (errors.length === 0 && data.agentId) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para configurar este agente");
      }
    }

    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async validateMessage(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];

    // Validar campos requeridos
    if (!data.integrationId) {
      errors.push("ID de integración es requerido");
    }

    if (!data.to) {
      errors.push("Destinatario (to) es requerido");
    } else if (!this.isValidPhoneNumber(data.to)) {
      errors.push("Formato de número de destinatario inválido");
    }

    if (!data.type) {
      errors.push("Tipo de mensaje es requerido");
    } else if (
      !["text", "template", "image", "document", "audio", "video"].includes(
        data.type
      )
    ) {
      errors.push("Tipo de mensaje inválido");
    }

    // Validar contenido según tipo
    if (data.type === "text" && (!data.text || !data.text.body)) {
      errors.push("Contenido de texto es requerido");
    }

    if (data.type === "template" && (!data.template || !data.template.name)) {
      errors.push("Nombre de plantilla es requerido");
    }

    // Verificar acceso a la integración si no hay errores
    if (errors.length === 0 && data.integrationId) {
      const hasAccess = await this.verifyIntegrationAccess(
        data.integrationId,
        userId
      );
      if (!hasAccess) {
        errors.push("No tienes permiso para usar esta integración");
      }
    }

    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  private isValidPhoneNumber(phone: string): boolean {
    // Basic international format: +[country code][number]
    const regex = /^\+[1-9]\d{1,14}$/;
    return regex.test(phone);
  }

  private async verifyAgentAccess(
    agentId: string,
    userId: string
  ): Promise<boolean> {
    try {
      // Verify if the user is the agent's owner
      const agentsTable = this.storageService.getTableClient(
        STORAGE_TABLES.AGENTS
      );

      try {
        const agent = await agentsTable.getEntity("agent", agentId);
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        this.logger.warn(`Agent with ID ${agentId} not found during access verification:`, error);
        return false;
      }

      // If not owner, check for roles in the agent
      const rolesTable = this.storageService.getTableClient(
        STORAGE_TABLES.USER_ROLES
      );

      const roles = rolesTable.listEntities({
        queryOptions: {
          filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true`,
        },
      });

      for await (const role of roles) {
        // If an active role is found, access is granted
        return true;
      }

      return false; // No ownership and no active role found
    } catch (error) {
      this.logger.error(
        `Error verifying agent access for agentId=${agentId}, userId=${userId}:`,
        error
      );
      return false;
    }
  }

  private async verifyIntegrationAccess(
    integrationId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );

      // Look up the integration
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` },
      });

      for await (const integration of integrations) {
        const agentId = integration.agentId as string;

        // Verify access to the associated agent
        return await this.verifyAgentAccess(agentId, userId);
      }

      return false;
    } catch (error) {
      this.logger.error(
        `Error verifying access to integration ${integrationId}:`,
        error
      );
      return false;
    }
  }
}