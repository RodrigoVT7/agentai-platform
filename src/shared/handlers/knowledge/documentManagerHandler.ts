import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES, BLOB_CONTAINERS } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { HttpResponseInit } from "@azure/functions";
import { DocumentProcessingStatus, DocumentProcessingQueueMessage } from "../../models/document.model";
import { AzureAiSearchService } from "../../services/azureAiSearch.service";
import { SearchClient } from "@azure/search-documents";

interface ListOptions {
  limit: number;
  skip: number;
  status?: string;
}

export class DocumentManagerHandler {
  private storageService: StorageService;
  private logger: Logger;
  // Opcional: Añadir cliente de AI Search si necesitas obtener stats de chunks/vectores desde ahí
  private aiSearchService: AzureAiSearchService;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
    this.aiSearchService = new AzureAiSearchService(this.logger);
  }

  /**
   * Obtener detalles de un documento
   */
  public async getDocument(documentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);

      // Buscar documento en todas las particiones ya que no sabemos el knowledgeBaseId
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${documentId}'` }
      });

      let doc;
      for await (const entity of documents) {
        doc = entity;
        break;
      }

      if (!doc) {
        return {
          status: 404,
          jsonBody: { error: "Documento no encontrado" }
        };
      }

      // Verificar que el usuario tiene acceso a este documento
      const knowledgeBaseId = doc.partitionKey as string;
      const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);

      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este documento" }
        };
      }

      // const stats = await this.getDocumentStats(documentId, knowledgeBaseId);
      // TODO (Opcional): Si necesitas estadísticas de chunks/vectores, impleméntalo
      // consultando Azure AI Search aquí (ej. contando documentos con ese documentId)

      // Formatear respuesta (sin las stats de vectores de Table Storage)
      return {
        status: 200,
        jsonBody: {
          id: doc.id,
          knowledgeBaseId: doc.knowledgeBaseId,
          name: doc.name,
          type: doc.type,
          storageUrl: doc.storageUrl,
          sizeMb: doc.sizeMb,
          processingStatus: doc.processingStatus,
          createdBy: doc.createdBy,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          isActive: doc.isActive,
          // stats // Eliminado temporalmente
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener documento ${documentId}:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      // Utiliza createAppError para consistencia si lo tienes definido, sino lanza error normal
      throw createAppError(500, `Error al obtener documento: ${errorMessage}`);
    }
  }

  /**
   * Listar documentos de una base de conocimiento
   */
  public async listDocuments(knowledgeBaseId: string, userId: string, options: ListOptions): Promise<HttpResponseInit> {
     try {
       // Verificar que el usuario tiene acceso a la base de conocimiento
       const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);

       if (!hasAccess) {
         return {
           status: 403,
           jsonBody: { error: "No tienes permiso para acceder a esta base de conocimiento" }
         };
       }

       const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);

       // Construir filtro base
       let filter = `PartitionKey eq '${knowledgeBaseId}' and isActive eq true`;

       // Añadir filtro de estado si se proporciona
       if (options.status) {
         filter += ` and processingStatus eq '${options.status}'`;
       }

       const documents = [];
       const docEntities = tableClient.listEntities({ // Quitado await innecesario aquí
         queryOptions: { filter }
       });

       // Recolectar todos los documentos
       const allDocs = [];
       for await (const doc of docEntities) {
         allDocs.push(doc);
       }

       // Aplicar paginación después de ordenar
       allDocs.sort((a, b) => {
         // Ordenar por fecha de creación (más reciente primero)
         const aTime = a.createdAt as number;
         const bTime = b.createdAt as number;
         return bTime - aTime;
       });

       // Aplicar salto y límite
       const paginatedDocs = allDocs.slice(options.skip, options.skip + options.limit);

       // Mapear a formato de respuesta
       for (const doc of paginatedDocs) {
         documents.push({
           id: doc.id,
           knowledgeBaseId: doc.knowledgeBaseId,
           name: doc.name,
           type: doc.type,
           sizeMb: doc.sizeMb,
           processingStatus: doc.processingStatus,
           createdAt: doc.createdAt,
           updatedAt: doc.updatedAt
         });
       }

       // Obtener conteos por estado para estadísticas
       const statusCounts = await this.getStatusCounts(knowledgeBaseId);

       return {
         status: 200,
         jsonBody: {
           documents,
           pagination: {
             total: allDocs.length,
             limit: options.limit,
             skip: options.skip
           },
           stats: statusCounts
         }
       };
     } catch (error) {
       this.logger.error(`Error al listar documentos para KB ${knowledgeBaseId}:`, error);

       const errorMessage = error instanceof Error ? error.message : String(error);
       throw createAppError(500, `Error al listar documentos: ${errorMessage}`);
     }
   }


  /**
   * Eliminar un documento
   */
  public async deleteDocument(documentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);

      // Buscar documento
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${documentId}'` }
      });

      let doc;
      for await (const entity of documents) {
        doc = entity;
        break;
      }

      if (!doc) {
        return {
          status: 404,
          jsonBody: { error: "Documento no encontrado" }
        };
      }

      // Verificar que el usuario tiene acceso a este documento
      const knowledgeBaseId = doc.partitionKey as string;
      const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);

      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para eliminar este documento" }
        };
      }

      // Realizar eliminación lógica
      await tableClient.updateEntity({
        partitionKey: knowledgeBaseId,
        rowKey: documentId,
        isActive: false,
        updatedAt: Date.now()
      }, "Merge");

      // --- ELIMINADO: Llamada a deleteVectors que usaba la tabla 'vectors' ---
      // await this.deleteVectors(documentId);
      // TODO (Opcional): Implementar la eliminación de chunks/vectores desde Azure AI Search
      // Esto requeriría buscar todos los chunks por documentId en AI Search y eliminarlos.
      await this.deleteIndexedVectors(documentId);


      this.logger.info(`Documento ${documentId} eliminado (desactivado)`);

      return {
        status: 200,
        jsonBody: {
          id: documentId,
          message: "Documento eliminado con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar documento ${documentId}:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al eliminar documento: ${errorMessage}`);
    }
  }

    /**
     * Elimina vectores/chunks asociados a un documento desde Azure AI Search
     */
    private async deleteIndexedVectors(documentId: string): Promise<void> {
        try {
            this.logger.debug(`Iniciando eliminación de vectores en AI Search para documento ${documentId}`);
            const searchClient = this.aiSearchService.getAdminClient(); // Necesita clave de admin

            // 1. Buscar los chunkIds asociados al documentId
            const searchResults = await searchClient.search<any>("*", {
              filter: `documentId eq '${documentId}'`,
              select: ["chunkId"], // Solo necesitamos el ID para eliminar
          });

            const documentsToDelete: { chunkId: string }[] = [];
            for await (const result of searchResults.results) {
                documentsToDelete.push({ chunkId: result.document.chunkId });
            }

            // 2. Eliminar los documentos (chunks) encontrados
            if (documentsToDelete.length > 0) {
                this.logger.info(`Eliminando ${documentsToDelete.length} chunks de AI Search para documento ${documentId}`);
                const deleteResult = await searchClient.deleteDocuments(documentsToDelete);

                // Verificar resultados (opcional)
                let successCount = 0;
                let failureCount = 0;
                deleteResult.results.forEach(res => res.succeeded ? successCount++ : failureCount++);
                this.logger.info(`Resultados eliminación AI Search: ${successCount} éxitos, ${failureCount} fallos.`);
                if (failureCount > 0) {
                     this.logger.warn(`Algunos chunks no pudieron ser eliminados de AI Search para documento ${documentId}`);
                }
            } else {
                this.logger.info(`No se encontraron chunks para eliminar en AI Search para documento ${documentId}`);
            }

        } catch (error) {
            this.logger.error(`Error al eliminar vectores/chunks de AI Search para documento ${documentId}:`, error);
            // No relanzar para no detener la eliminación del documento principal
        }
    }


  /**
   * Reprocesar un documento
   */
  public async reprocessDocument(documentId: string, userId: string): Promise<HttpResponseInit> {
     try {
       const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);

       // Buscar documento
       const documents = await tableClient.listEntities({
         queryOptions: { filter: `RowKey eq '${documentId}'` }
       });

       let doc;
       for await (const entity of documents) {
         doc = entity;
         break;
       }

       if (!doc) {
         return {
           status: 404,
           jsonBody: { error: "Documento no encontrado" }
         };
       }

       // Verificar que el usuario tiene acceso a este documento
       const knowledgeBaseId = doc.knowledgeBaseId as string;
       // Necesitamos obtener el agentId asociado a la KB
       const agentId = await this.getAgentIdFromKnowledgeBase(knowledgeBaseId);

       if (!agentId) {
         this.logger.error(`No se pudo encontrar el agentId para la KB ${knowledgeBaseId} al reprocesar doc ${documentId}`);
         return {
           status: 404,
           jsonBody: { error: "Base de conocimiento asociada no encontrada" }
         };
       }

       const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);

       if (!hasAccess) {
         return {
           status: 403,
           jsonBody: { error: "No tienes permiso para reprocesar este documento" }
         };
       }

       // Actualizar estado del documento a PENDING
       await tableClient.updateEntity({
         partitionKey: knowledgeBaseId,
         rowKey: documentId,
         processingStatus: DocumentProcessingStatus.PENDING,
         processingError: null, // Limpiar error anterior si existe
         updatedAt: Date.now()
       }, "Merge");

       // --- ELIMINADO: Llamada a deleteVectors ---
       // await this.deleteVectors(documentId);
       // TODO (Importante): Implementar la eliminación de chunks/vectores desde Azure AI Search antes de re-encolar
       await this.deleteIndexedVectors(documentId);


       // Encolar de nuevo para procesamiento
       const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.DOCUMENT_PROCESSING);

       const processingMessage: DocumentProcessingQueueMessage = {
         documentId,
         knowledgeBaseId,
         agentId, // Pasar el agentId recuperado
         storageUrl: doc.storageUrl as string,
         originalName: doc.name as string,
         contentType: doc.type as string,
         uploadedAt: Date.now() // Usar timestamp actual para el reprocesamiento
       };

       await queueClient.sendMessage(Buffer.from(JSON.stringify(processingMessage)).toString('base64'));

       this.logger.info(`Documento ${documentId} encolado para reprocesamiento`);

       return {
         status: 200,
         jsonBody: {
           id: documentId,
           status: DocumentProcessingStatus.PENDING,
           message: "Documento encolado para reprocesamiento"
         }
       };
     } catch (error) {
       this.logger.error(`Error al reprocesar documento ${documentId}:`, error);

       const errorMessage = error instanceof Error ? error.message : String(error);
       throw createAppError(500, `Error al reprocesar documento: ${errorMessage}`);
     }
   }


  // --- ELIMINADO: Método privado deleteVectors ---

  /**
   * Verificar si un usuario tiene acceso a una base de conocimiento
   */
  private async checkKnowledgeBaseAccess(knowledgeBaseId: string, userId: string): Promise<boolean> {
    try {
      // Obtener agentId de la base de conocimiento
      const agentId = await this.getAgentIdFromKnowledgeBase(knowledgeBaseId);
      if (!agentId) return false;

      // Verificar acceso al agente
      return await this.checkAgentAccess(agentId, userId);
    } catch (error) {
      this.logger.error(`Error al verificar acceso a KB ${knowledgeBaseId}:`, error);
      return false;
    }
  }

  /**
   * Verificar si un usuario tiene acceso a un agente
   */
  private async checkAgentAccess(agentId: string, userId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);

      try {
        const agent = await tableClient.getEntity('agent', agentId);
        if (agent.userId === userId) return true;
      } catch (error: any) {
         // Ignorar 404, significa que el agente no existe o no se encontró por ID (lo cual es un fallo de acceso indirecto)
         if (error.statusCode !== 404) {
              this.logger.warn(`Error buscando agente ${agentId} para verificar acceso:`, error);
         }
         // Continuar para verificar roles
      }

      // Si no es propietario, verificar roles
      const rolesClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = rolesClient.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
      });

      for await (const role of roles) {
        // Si encontramos algún rol activo, tiene acceso
        return true;
      }

      // Si no es propietario ni tiene rol, no tiene acceso
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar acceso del usuario ${userId} al agente ${agentId}:`, error);
      return false;
    }
  }

   /**
   * Obtener conteos por estado de procesamiento
   */
   private async getStatusCounts(knowledgeBaseId: string): Promise<Record<string, number>> {
     try {
       const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);

       const counts: Record<string, number> = {
         total: 0,
         pending: 0,
         processing: 0,
         processed: 0,
         vectorized: 0,
         failed: 0
       };

       const documents = tableClient.listEntities({ // Quitado await innecesario
         queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}' and isActive eq true` }
       });

       for await (const doc of documents) {
         counts.total++;

         const status = doc.processingStatus as string;
         // Usar hasOwnProperty para seguridad
         if (status && Object.prototype.hasOwnProperty.call(counts, status)) {
           counts[status]++;
         }
       }

       return counts;
     } catch (error) {
       this.logger.warn(`Error al obtener conteos por estado para KB ${knowledgeBaseId}:`, error);
       // Devolver ceros en caso de error
       return {
         total: 0, pending: 0, processing: 0, processed: 0, vectorized: 0, failed: 0
       };
     }
   }


   /**
    * Obtener agentId de una base de conocimiento
    */
   private async getAgentIdFromKnowledgeBase(knowledgeBaseId: string): Promise<string | null> {
     try {
       const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);

       // La partitionKey es agentId, pero si no la sabemos, buscamos por RowKey
       const knowledgeBases = tableClient.listEntities({ // Quitado await innecesario
         queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
       });

       for await (const kb of knowledgeBases) {
         // La PartitionKey es el agentId
         return kb.partitionKey as string;
       }

       this.logger.warn(`No se encontró KB con ID ${knowledgeBaseId}`);
       return null;
     } catch (error: any) {
         // Ignorar 404
         if (error.statusCode !== 404) {
             this.logger.error(`Error al obtener agentId de KB ${knowledgeBaseId}:`, error);
         }
       return null;
     }
   }

}
