// src/shared/handlers/knowledge/embeddingGeneratorHandler.ts
import { StorageService } from "../../services/storage.service";
import { OpenAIService } from "../../services/openai.service";
import { STORAGE_TABLES, BLOB_CONTAINERS } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { DocumentProcessingStatus } from "../../models/document.model";
import { EmbeddingQueueMessage } from "../../models/documentProcessor.model";
import { EmbeddingResult, Vector } from "../../models/embedding.model";
import { AzureAiSearchService } from "../../services/azureAiSearch.service";
import { SearchClient } from "@azure/search-documents";

export class EmbeddingGeneratorHandler {
  private storageService: StorageService;
  private openaiService: OpenAIService;
  private aiSearchService: AzureAiSearchService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.storageService = new StorageService();
    this.openaiService = new OpenAIService(this.logger);
    this.aiSearchService = new AzureAiSearchService(this.logger);
  }
  
 /**
   * Procesa un mensaje de la cola y genera embeddings
   */
 public async execute(message: EmbeddingQueueMessage): Promise<EmbeddingResult> {
  const { chunkId, documentId, knowledgeBaseId, content, agentId } = message;
  
  try {
    this.logger.info(`Generando embedding para chunk ${chunkId} del documento ${documentId}`);
    
    // Generar embedding
    const vector = await this.openaiService.getEmbedding(content);
    
    if (!vector || vector.length === 0) {
      throw createAppError(500, `Error al generar embedding para chunk ${chunkId}`);
    }
    
    await this.indexVectorInAiSearch(chunkId, documentId, knowledgeBaseId, vector, content);

    // Comprobar si todos los chunks tienen embedding y actualizar estado del documento
    await this.checkDocumentCompletion(documentId, knowledgeBaseId, agentId);
    
    this.logger.info(`Embedding generado con éxito para chunk ${chunkId}`);
    
    return {
      chunkId,
      documentId,
      knowledgeBaseId,
      success: true,
      vector
    };
  } catch (error: unknown) {
    this.logger.error(`Error al generar embedding para chunk ${chunkId}:`, error);
    
    // No actualizar documento a fallido si solo falla un chunk
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      chunkId,
      documentId,
      knowledgeBaseId,
      success: false,
      error: errorMessage || 'Error desconocido al generar embedding'
    };
  }
}

  /**
     * Indexa un vector en Azure AI Search
     */
  private async indexVectorInAiSearch(
    chunkId: string,
    documentId: string,
    knowledgeBaseId: string,
    vector: number[],
    content: string
): Promise<void> {
    try {
        const adminClient = this.aiSearchService.getAdminClient();

        const documentToUpload = {
            chunkId: chunkId,
            documentId: documentId,
            knowledgeBaseId: knowledgeBaseId,
            content: content,
            vector: vector,
            // Puedes añadir más metadatos aquí si los definiste en el índice
        };

        const result = await adminClient.mergeOrUploadDocuments([documentToUpload]);

        // Verificar resultados (opcional pero recomendado)
        if (result.results?.length > 0 && result.results[0].succeeded) {
            this.logger.debug(`Chunk ${chunkId} indexado/actualizado en Azure AI Search.`);
        } else {
             const errorDetails = result.results?.length > 0 ? result.results[0].errorMessage : "Error desconocido";
            throw new Error(`Fallo al indexar chunk ${chunkId}: ${errorDetails}`);
        }

    } catch (error) {
        this.logger.error(`Error al indexar vector en Azure AI Search para chunk ${chunkId}:`, error);
        throw error; // Relanzar para que se maneje en execute()
    }
}
  
  
    /**
     * Comprueba si todos los chunks de un documento han sido indexados en AI Search
     * y actualiza el estado del documento si es así.
     */
    private async checkDocumentCompletion(documentId: string, knowledgeBaseId: string, agentId: string): Promise<void> {
        let totalChunksExpected = 0;
        let currentIndexedCount = 0;
        let currentDocStatus: DocumentProcessingStatus | undefined;
        const docTableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
  
        try {
            // --- Obtener estado actual del documento ---
            try {
                 const currentDoc = await docTableClient.getEntity(knowledgeBaseId, documentId);
                 currentDocStatus = currentDoc.processingStatus as DocumentProcessingStatus;
  
                 // Si ya está vectorizado, no hacer nada más.
                 if (currentDocStatus === DocumentProcessingStatus.VECTORIZED) {
                     this.logger.debug(`Documento ${documentId} ya está marcado como VECTORIZED. Saltando verificación.`);
                     return;
                 }
                  // Si está fallido, tampoco intentar actualizar (requiere reproceso manual)
                 if (currentDocStatus === DocumentProcessingStatus.FAILED) {
                      this.logger.debug(`Documento ${documentId} está en estado FAILED. Saltando verificación.`);
                      return;
                 }
  
            } catch (error: any) {
                  // Si no se encuentra el documento en la tabla, no podemos verificar. Log y salir.
                 if (error.statusCode === 404) {
                     this.logger.warn(`No se encontró el documento ${documentId} en Table Storage para verificar completitud.`);
                     return;
                 }
                 // Otros errores al obtener el documento
                 this.logger.error(`Error al obtener estado actual del documento ${documentId} antes de verificar:`, error);
                 return; // No continuar si no podemos obtener el estado actual
            }
  
  
            // --- Obtener total de chunks esperados ---
            try {
                const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.PROCESSED_DOCUMENTS);
                const metadataBlobClient = containerClient.getBlobClient(`${agentId}/${knowledgeBaseId}/${documentId}/metadata.json`);
  
                if (await metadataBlobClient.exists()) {
                    const downloadResponse = await metadataBlobClient.download();
                    const metadataText = await this.streamToString(downloadResponse.readableStreamBody);
                    const metadata = JSON.parse(metadataText);
                    totalChunksExpected = metadata.chunkCount || 0;

                    let attempts = 0;
                    const maxAttempts = 3;
                    const retryDelay = 1000;

                    while (attempts < maxAttempts) {
                        try {
                            const searchClient: SearchClient<any> = this.aiSearchService.getSearchClient();
                            const searchResults = await searchClient.search("*", {
                                filter: `documentId eq '${documentId}'`,
                                includeTotalCount: true,
                                top: 0
                            });
                            currentIndexedCount = searchResults.count ?? 0;
                            this.logger.debug(`Documento ${documentId}: Intento ${attempts + 1}: ${currentIndexedCount} chunks encontrados (Esperados: ${totalChunksExpected}).`);
                
                            // Si el conteo es suficiente O si ya no hay más reintentos, salir del bucle
                            if (currentIndexedCount >= totalChunksExpected || attempts === maxAttempts - 1) {
                                 break;
                            }
                
                            // Esperar antes del siguiente intento
                            attempts++;
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                
                        } catch (error) {
                            this.logger.error(`Intento ${attempts + 1}: Error al contar chunks indexados para ${documentId}:`, error);
                            // Si falla la consulta, probablemente no tenga sentido reintentar inmediatamente
                            // Considerar salir del bucle o manejar el error de forma diferente
                             break; // Salir del bucle en caso de error en la consulta
                        }
                    }

                    
                    this.logger.debug(`Documento ${documentId}: Se esperan ${totalChunksExpected} chunks según metadata.json.`);
                } else {
                    this.logger.warn(`No se encontró metadata.json para el documento ${documentId}. No se puede verificar la completitud.`);
                    return;
                }
            } catch (error) {
                 this.logger.error(`Error al leer metadata.json para ${documentId}:`, error);
                 // Marcar como FAILED si no podemos leer metadatos esenciales
                 await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.FAILED, `Error leyendo metadata.json: ${error instanceof Error ? error.message : String(error)}`);
                 return;
            }
  
            if (totalChunksExpected === 0) {
                this.logger.warn(`El documento ${documentId} no tiene chunks esperados según metadata.json. Marcando como fallido.`);
                await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.FAILED, "Documento sin chunks procesados según metadata.");
                return;
            }
  
            // --- Contar chunks indexados en Azure AI Search ---
            try {
                // Opcional: Añadir un pequeño retraso aquí si la latencia es un problema persistente
                // await new Promise(resolve => setTimeout(resolve, 500)); // Esperar 500ms
  
                const searchClient: SearchClient<any> = this.aiSearchService.getSearchClient();
                const searchResults = await searchClient.search("*", {
                    filter: `documentId eq '${documentId}'`,
                    includeTotalCount: true,
                    top: 0
                });
                currentIndexedCount = searchResults.count ?? 0;
                this.logger.debug(`Documento ${documentId}: ${currentIndexedCount} chunks encontrados en Azure AI Search (Esperados: ${totalChunksExpected}).`);
            } catch (error) {
                this.logger.error(`Error al contar chunks indexados en Azure AI Search para ${documentId}:`, error);
                // No actualizar estado si no podemos contar
                return;
            }
  
  
            // --- Comparar y actualizar estado si es necesario ---
            if (currentIndexedCount >= totalChunksExpected) {
                  // Solo actualiza si no está ya VECTORIZED (verificado al inicio)
                  await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.VECTORIZED);
                  this.logger.info(`Documento ${documentId} completamente vectorizado (${currentIndexedCount}/${totalChunksExpected}). Estado actualizado.`);
            } else {
                 this.logger.info(`Documento ${documentId} aún no está completamente vectorizado (${currentIndexedCount}/${totalChunksExpected}).`);
            }
        } catch (error) {
            this.logger.error(`Error general en checkDocumentCompletion para ${documentId}:`, error);
            // No propagamos el error para no detener el proceso de otros chunks
        }
    }
  
  /**
     * Actualiza el estado de procesamiento del documento
     */
  private async updateDocumentStatus(
    documentId: string,
    knowledgeBaseId: string,
    status: DocumentProcessingStatus,
    error?: unknown
): Promise<void> {
    try {
        const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
        const updateEntity: any = {
            partitionKey: knowledgeBaseId,
            rowKey: documentId,
            processingStatus: status,
            updatedAt: Date.now()
        };

        // Limpiar error si el estado no es FAILED
        if (status !== DocumentProcessingStatus.FAILED) {
            updateEntity.processingError = null; // o eliminar el campo si es posible
        }
        // Añadir error si el estado es FAILED
        else if (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : typeof error === 'object' && error !== null && 'message' in error
                  ? String((error as { message: unknown }).message)
                  : String(error);
            updateEntity.processingError = errorMessage.substring(0, 1024); // Limitar longitud
        }

        await tableClient.updateEntity(updateEntity, "Merge");
        this.logger.debug(`Estado del documento ${documentId} actualizado a ${status}`);
    } catch (updateError: any) {
        // Evitar error si el documento ya no existe (podría haber sido eliminado)
        if (updateError.statusCode !== 404) {
            this.logger.error(`Error al actualizar estado del documento ${documentId} a ${status}:`, updateError);
        }
    }
}

  /**
        * Función auxiliar para convertir stream a string
        */
  private async streamToString(readableStream: NodeJS.ReadableStream | undefined): Promise<string> {
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


}