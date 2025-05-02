// src/shared/handlers/integrations/integrationCatalogHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
// *** Asegúrate de importar CapabilityToolDefinition aquí también si no lo hiciste ***
import { IntegrationType, IntegrationCatalogItem, CapabilityToolDefinition } from "../../models/integration.model";

export class IntegrationCatalogHandler {
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  async execute(userId: string, options: { category?: string; limit: number; skip: number }): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATION_CATALOG);
      let filter = '';
      if (options.category) {
        filter = `type eq '${options.category}'`;
      }

      const catalog: IntegrationCatalogItem[] = [];
      const items = tableClient.listEntities({ queryOptions: filter ? { filter } : undefined });

      const allItems: IntegrationCatalogItem[] = [];
      for await (const item of items) {
           try {
                 // Parsear campos JSON
                 const capabilityTools = typeof item.capabilityTools === 'string' ? JSON.parse(item.capabilityTools) : (Array.isArray(item.capabilityTools) ? item.capabilityTools : []);
                 const configSchema = typeof item.configSchema === 'string' ? JSON.parse(item.configSchema) : (typeof item.configSchema === 'object' ? item.configSchema : {});

                 allItems.push({
                     id: item.rowKey as string, // Asumiendo ID es RowKey
                     name: item.name as string,
                     description: item.description as string,
                     type: item.type as IntegrationType,
                     provider: item.provider as string,
                     icon: item.icon as string,
                     capabilityTools: capabilityTools as CapabilityToolDefinition[], // <-- Usar campo correcto
                     requiresAuth: item.requiresAuth as boolean,
                     setupGuide: item.setupGuide as string,
                     configSchema: configSchema
                 });
            } catch (parseError) {
                 this.logger.warn(`Error parseando item catálogo ${item.rowKey}:`, parseError);
            }
      }

      // Aplicar paginación
      const paginatedCatalog = allItems.slice(options.skip, options.skip + options.limit);

      return {
        catalog: paginatedCatalog,
        total: allItems.length, // Usar longitud total antes de paginar
        limit: options.limit,
        skip: options.skip
      };
    } catch (error) {
      this.logger.error("Error al obtener catálogo:", error);
      if (error && typeof error === 'object' && 'statusCode' in error) { throw error; }
      throw createAppError(500, "Error al obtener catálogo");
    }
  }
}