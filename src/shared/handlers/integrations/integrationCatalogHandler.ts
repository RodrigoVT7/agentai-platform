// src/shared/handlers/integrations/integrationCatalogHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { IntegrationType, IntegrationCatalogItem } from "../../models/integration.model";

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
      
      // Construir filtro base
      let filter = '';
      
      // Añadir filtro de categoría si se proporciona
      if (options.category) {
        filter = `type eq '${options.category}'`;
      }
      
      // Obtener catálogo
      const catalog: IntegrationCatalogItem[] = [];
      const items = tableClient.listEntities({
        queryOptions: filter ? { filter } : undefined
      });
      
      for await (const item of items) {
        catalog.push({
          id: item.id as string,
          name: item.name as string,
          description: item.description as string,
          type: item.type as IntegrationType,
          provider: item.provider as string,
          icon: item.icon as string,
          capabilities: item.capabilities as string[],
          requiresAuth: item.requiresAuth as boolean,
          setupGuide: item.setupGuide as string,
          configSchema: typeof item.configSchema === 'string' 
            ? JSON.parse(item.configSchema) 
            : item.configSchema as Record<string, any>
        });
      }
      
      // Aplicar paginación
      const paginatedCatalog = catalog.slice(options.skip, options.skip + options.limit);
      
      return {
        catalog: paginatedCatalog,
        total: catalog.length,
        limit: options.limit,
        skip: options.skip
      };
    } catch (error) {
      this.logger.error("Error al obtener catálogo de integraciones:", error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, "Error al obtener catálogo de integraciones");
    }
  }
}