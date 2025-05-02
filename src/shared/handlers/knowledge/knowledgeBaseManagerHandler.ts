import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, BLOB_CONTAINERS } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { HttpResponseInit } from "@azure/functions";
import { AzureAiSearchService } from "../../services/azureAiSearch.service";

export class KnowledgeBaseManagerHandler {
  private storageService: StorageService;
  private logger: Logger;
  private aiSearchService: AzureAiSearchService;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
     this.aiSearchService = new AzureAiSearchService(this.logger);
  }

  /**
   * Crear una nueva base de conocimiento
   */
  public async createKnowledgeBase(data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const { agentId, name, description } = data;

      // Verificar si el usuario tiene acceso al agente
      const hasAccess = await this.verifyAgentAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este agente" }
        };
      }

      // Generar nuevo ID para la base de conocimiento
      const knowledgeBaseId = uuidv4();
      const now = Date.now();

      // Guardar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);

      await tableClient.createEntity({
        partitionKey: agentId, // Usar agentId como PartitionKey para agrupar KBs por agente
        rowKey: knowledgeBaseId,
        id: knowledgeBaseId,
        agentId, // Guardar agentId también como campo por conveniencia
        name,
        description: description || "",
        type: "vector", // Añadir tipo si no existe, asumiendo vector
        vectorConfig: "{}", // Añadir config vacía si no existe
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        isActive: true
      });

      // Crear contenedor Blob para esta KB si no existe (Esta lógica puede ser opcional)
      try {
        const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.KNOWLEDGE_BASES); // O un contenedor más específico
        await containerClient.createIfNotExists();

      } catch (error) {
        this.logger.warn(`Error relacionado con blob para KB ${knowledgeBaseId}:`, error);
        // Continuamos aunque falle esto, no es crítico
      }

      this.logger.info(`Base de conocimiento ${knowledgeBaseId} creada para el agente ${agentId}`);

      return {
        status: 201,
        jsonBody: {
          id: knowledgeBaseId,
          agentId,
          name,
          description: description || "",
          createdAt: now,
          createdBy: userId
        }
      };
    } catch (error) {
      this.logger.error("Error al crear base de conocimiento:", error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al crear base de conocimiento: ${errorMessage}`);
    }
  }


  /**
   * Obtener detalles de una base de conocimiento
   */
  public async getKnowledgeBase(knowledgeBaseId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);

      // Buscar KB en todas las particiones o por PK si conocemos agentId
      // Como no lo sabemos aquí, buscamos por RowKey
      const knowledgeBases = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
      });

      let kb;
      for await (const entity of knowledgeBases) {
        kb = entity;
        break; // Asumimos que el ID (RowKey) es único
      }

      if (!kb || kb.isActive === false) { // Verificar si está activo
        return {
          status: 404,
          jsonBody: { error: "Base de conocimiento no encontrada o inactiva" }
        };
      }

      // Verificar si el usuario tiene acceso al agente de esta KB
      const agentId = kb.partitionKey as string; // PartitionKey es agentId
      const hasAccess = await this.verifyAgentAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta base de conocimiento" }
        };
      }

      // Contar documentos activos
      const documentCount = await this.countDocuments(knowledgeBaseId);

      return {
        status: 200,
        jsonBody: {
          id: kb.id,
          agentId: kb.agentId, // Usar el campo explícito si existe, sino el PK
          name: kb.name,
          description: kb.description,
          createdAt: kb.createdAt,
          updatedAt: kb.updatedAt,
          createdBy: kb.createdBy,
          isActive: kb.isActive,
          stats: {
            documentCount
            // ...stats // Eliminado temporalmente
          }
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener base de conocimiento ${knowledgeBaseId}:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al obtener base de conocimiento: ${errorMessage}`);
    }
  }

    /**
     * Listar bases de conocimiento para un agente
     */
    public async listKnowledgeBases(agentId: string, userId: string): Promise<HttpResponseInit> {
        try {
            // Verificar si el usuario tiene acceso al agente
            const hasAccess = await this.verifyAgentAccess(agentId, userId);
            if (!hasAccess) {
                return {
                    status: 403,
                    jsonBody: { error: "No tienes permiso para acceder a este agente" }
                };
            }

            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);

            const kbs = [];
            const knowledgeBases = tableClient.listEntities({
                // Filtrar por PartitionKey (agentId) y que esté activa
                queryOptions: { filter: `PartitionKey eq '${agentId}' and isActive eq true` }
            });

            for await (const kb of knowledgeBases) {
                // Contar documentos activos para cada KB
                const documentCount = await this.countDocuments(kb.rowKey as string); // RowKey es knowledgeBaseId

                kbs.push({
                    id: kb.rowKey, // ID es RowKey
                    agentId: kb.partitionKey, // AgentId es PartitionKey
                    name: kb.name,
                    description: kb.description,
                    createdAt: kb.createdAt,
                    updatedAt: kb.updatedAt,
                    documentCount
                });
            }

            return {
                status: 200,
                jsonBody: {
                    knowledgeBases: kbs,
                    count: kbs.length
                }
            };
        } catch (error) {
            this.logger.error(`Error al listar bases de conocimiento para agente ${agentId}:`, error);

            const errorMessage = error instanceof Error ? error.message : String(error);
            throw createAppError(500, `Error al listar bases de conocimiento: ${errorMessage}`);
        }
    }

    /**
     * Actualizar una base de conocimiento existente
     */
    public async updateKnowledgeBase(knowledgeBaseId: string, data: any, userId: string): Promise<HttpResponseInit> {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);

            // Obtener KB existente y su agentId (PartitionKey)
            let kb;
            let agentId: string | undefined;
            const knowledgeBases = await tableClient.listEntities({
                queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
            });
            for await (const entity of knowledgeBases) {
                kb = entity;
                agentId = entity.partitionKey as string;
                break;
            }

            if (!kb || !agentId) {
                return {
                    status: 404,
                    jsonBody: { error: "Base de conocimiento no encontrada" }
                };
            }

            // Verificar si el usuario tiene acceso al agente de esta KB
            const hasAccess = await this.verifyAgentAccess(agentId, userId);
            if (!hasAccess) {
                return {
                    status: 403,
                    jsonBody: { error: "No tienes permiso para modificar esta base de conocimiento" }
                };
            }

            // Preparar datos para actualización
            const now = Date.now();
            const updateData: any = {
                partitionKey: agentId, // Usar PartitionKey recuperado
                rowKey: knowledgeBaseId, // Usar RowKey recuperado
                updatedAt: now
            };

            // Actualizar solo los campos proporcionados
            if (data.name !== undefined) updateData.name = data.name;
            if (data.description !== undefined) updateData.description = data.description;
            if (data.isActive !== undefined) updateData.isActive = data.isActive;

            // Actualizar en Table Storage
            await tableClient.updateEntity(updateData, "Merge");

            this.logger.info(`Base de conocimiento ${knowledgeBaseId} actualizada`);

            return {
                status: 200,
                jsonBody: {
                    id: knowledgeBaseId,
                    agentId: agentId,
                    name: data.name !== undefined ? data.name : kb.name,
                    description: data.description !== undefined ? data.description : kb.description,
                    updatedAt: now,
                    message: "Base de conocimiento actualizada con éxito"
                }
            };
        } catch (error) {
            this.logger.error(`Error al actualizar base de conocimiento ${knowledgeBaseId}:`, error);

            const errorMessage = error instanceof Error ? error.message : String(error);
            throw createAppError(500, `Error al actualizar base de conocimiento: ${errorMessage}`);
        }
    }


    /**
     * Eliminar una base de conocimiento
     */
    public async deleteKnowledgeBase(knowledgeBaseId: string, userId: string): Promise<HttpResponseInit> {
        try {
            const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);

            // Obtener KB existente y su agentId (PartitionKey)
            let kb;
            let agentId: string | undefined;
            const knowledgeBases = await tableClient.listEntities({
                queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
            });
             for await (const entity of knowledgeBases) {
                kb = entity;
                agentId = entity.partitionKey as string;
                break;
            }


            if (!kb || !agentId) {
                return {
                    status: 404,
                    jsonBody: { error: "Base de conocimiento no encontrada" }
                };
            }

            // Verificar si el usuario tiene acceso al agente de esta KB
            const hasAccess = await this.verifyAgentAccess(agentId, userId);
            if (!hasAccess) {
                return {
                    status: 403,
                    jsonBody: { error: "No tienes permiso para eliminar esta base de conocimiento" }
                };
            }

            // Realizar eliminación lógica (marcar como inactivo)
            await tableClient.updateEntity({
                partitionKey: agentId,
                rowKey: knowledgeBaseId,
                isActive: false,
                updatedAt: Date.now()
            }, "Merge");

            // Desactivar documentos asociados en Table Storage
            await this.deactivateDocuments(knowledgeBaseId);

             // TODO (Importante): Implementar la eliminación de TODOS los chunks/vectores
             // asociados a esta KB desde Azure AI Search.
             await this.deleteKnowledgeBaseVectors(knowledgeBaseId);


            this.logger.info(`Base de conocimiento ${knowledgeBaseId} eliminada (desactivada)`);

            return {
                status: 200,
                jsonBody: {
                    id: knowledgeBaseId,
                    message: "Base de conocimiento eliminada con éxito (y sus documentos desactivados)"
                }
            };
        } catch (error) {
            this.logger.error(`Error al eliminar base de conocimiento ${knowledgeBaseId}:`, error);

            const errorMessage = error instanceof Error ? error.message : String(error);
            throw createAppError(500, `Error al eliminar base de conocimiento: ${errorMessage}`);
        }
    }

     /**
      * Elimina todos los vectores/chunks de AI Search asociados a una KB.
      * ¡PRECAUCIÓN! Esta operación puede ser intensiva si hay muchos chunks.
      */
     private async deleteKnowledgeBaseVectors(knowledgeBaseId: string): Promise<void> {
          try {
              this.logger.warn(`Iniciando eliminación de TODOS los vectores en AI Search para KB ${knowledgeBaseId}`);
              const searchClient = this.aiSearchService.getAdminClient(); // Necesita clave de admin

              // 1. Buscar todos los chunkIds asociados a la KB
              //    (Puede ser necesario paginar si hay muchísimos chunks)
              let documentsToDelete: { chunkId: string }[] = [];
              const maxToDeletePerBatch = 1000; // Límite de Azure AI Search por lote

              const searchResults = await searchClient.search<any>("*", {
                filter: `knowledgeBaseId eq '${knowledgeBaseId}'`,
                select: ["chunkId"],
                top: maxToDeletePerBatch // Ajustar si se implementa paginación
            });

              for await (const result of searchResults.results) {
                   documentsToDelete.push({ chunkId: result.document.chunkId });
              }

              // TODO: Implementar paginación si se esperan más de 1000 chunks por KB

              // 2. Eliminar los documentos (chunks) encontrados
              if (documentsToDelete.length > 0) {
                  this.logger.info(`Eliminando ${documentsToDelete.length} chunks de AI Search para KB ${knowledgeBaseId}`);
                  const deleteResult = await searchClient.deleteDocuments(documentsToDelete);

                  // Verificar resultados (opcional)
                  let successCount = 0;
                  let failureCount = 0;
                  deleteResult.results.forEach(res => res.succeeded ? successCount++ : failureCount++);
                  this.logger.info(`Resultados eliminación AI Search (KB ${knowledgeBaseId}): ${successCount} éxitos, ${failureCount} fallos.`);
                   if (failureCount > 0) {
                       this.logger.error(`FALLO al eliminar algunos chunks de AI Search para KB ${knowledgeBaseId}`);
                   }
              } else {
                  this.logger.info(`No se encontraron chunks para eliminar en AI Search para KB ${knowledgeBaseId}`);
              }

          } catch (error) {
              this.logger.error(`Error CRÍTICO al eliminar vectores/chunks de AI Search para KB ${knowledgeBaseId}:`, error);
              // Considerar cómo manejar este error (¿reintentar?, ¿marcar KB como corrupta?)
          }
     }

    // --- MÉTODOS AUXILIARES (verifyAgentAccess, countDocuments, deactivateDocuments sin cambios) ---

  /**
   * Desactivar documentos asociados a una base de conocimiento
   */
   private async deactivateDocuments(knowledgeBaseId: string): Promise<void> {
       try {
           const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
           const now = Date.now();
           const documents = tableClient.listEntities({
               queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}' and isActive eq true` }
           });

           for await (const doc of documents) {
               if (doc.partitionKey && doc.rowKey) {
                   await tableClient.updateEntity({
                       partitionKey: doc.partitionKey as string,
                       rowKey: doc.rowKey as string,
                       isActive: false,
                       updatedAt: now
                   }, "Merge");
               }
           }
           this.logger.info(`Documentos desactivados para KB ${knowledgeBaseId}`);
       } catch (error) {
           this.logger.error(`Error al desactivar documentos para KB ${knowledgeBaseId}:`, error);
       }
   }

  /**
   * Contar documentos en una base de conocimiento
   */
  private async countDocuments(knowledgeBaseId: string): Promise<number> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);

      let count = 0;
      const documents = tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}' and isActive eq true` }
      });

      for await (const doc of documents) {
        count++;
      }

      return count;
    } catch (error) {
      this.logger.warn(`Error al contar documentos para KB ${knowledgeBaseId}:`, error);
      return 0;
    }
  }

    // --- ELIMINADO: Método privado getKnowledgeBaseStats ---

  /**
   * Verificar acceso de un usuario a un agente
   */
   private async verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
       try {
           const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
           try {
               const agent = await tableClient.getEntity('agent', agentId);
               if (agent.userId === userId) return true;
           } catch (error: any) {
                if (error.statusCode !== 404) { // Log error unless it's just 'not found'
                     this.logger.warn(`Error buscando agente ${agentId} para verificar acceso:`, error);
                }
                // Continue to check roles even if agent lookup fails (maybe roles exist anyway)
           }

           const rolesClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
           const roles = rolesClient.listEntities({
               queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
           });
           for await (const role of roles) {
               return true; // Found an active role
           }
           return false; // No ownership and no active role found
       } catch (error) {
           this.logger.error(`Error crítico al verificar acceso del usuario ${userId} al agente ${agentId}:`, error);
           return false;
       }
   }

}

// --- ELIMINADO: Función auxiliar streamToString (ya debería estar definida en documentManagerHandler o importada) ---
// Si no está, asegúrate de definirla o importarla aquí también.
/**
 * Función auxiliar para convertir stream a string
 */
 async function streamToString(readableStream: NodeJS.ReadableStream | undefined): Promise<string> {
     if (!readableStream) return '';
     return new Promise((resolve, reject) => {
         const chunks: Buffer[] = [];
         readableStream.on('data', (data) => {
             chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
         });
         readableStream.on('end', () => {
             resolve(Buffer.concat(chunks).toString('utf8'));
         });
         readableStream.on('error', reject);
     });
 }