// src/shared/handlers/knowledge/documentSearchHandler.ts
import {
    SearchClient,
    SearchDocumentsResult,
    SearchOptions,
    VectorQuery // <- Mantén esta importación
} from "@azure/search-documents";
import { StorageService } from "../../services/storage.service"; // Asumiendo que aún puedes necesitarlo para algo, si no, quitar.
import { OpenAIService } from "../../services/openai.service";
import { AzureAiSearchService } from "../../services/azureAiSearch.service";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import {
    SearchQuery,
    SearchResultItem,
    SearchResults
} from "../../models/search.model";

interface IndexedChunkDocument {
    chunkId: string;
    documentId: string;
    knowledgeBaseId: string;
    content: string;
    metadata?: string; 
}


export class DocumentSearchHandler {
    private openaiService: OpenAIService;
    private aiSearchService: AzureAiSearchService;
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || createLogger();
        this.openaiService = new OpenAIService(this.logger);
        this.aiSearchService = new AzureAiSearchService(this.logger);
    }

    /**
     * Ejecuta una búsqueda vectorial/híbrida usando Azure AI Search
     */
    public async execute(params: SearchQuery): Promise<SearchResults> {
        const { query, knowledgeBaseId, limit = 5, threshold = 0.7, includeContent = true } = params;

        try {
            this.logger.info(`Realizando búsqueda en Azure AI Search: "${query}" en KB ${knowledgeBaseId}`);

            // 1. Generar embedding para la consulta
            const queryEmbedding = await this.generateQueryEmbedding(query);

            // 2. Obtener el cliente de búsqueda
            const searchClient = this.aiSearchService.getSearchClient();

            // 4. Definir opciones de búsqueda generales
            // Corrección TS2304: Usar la interfaz definida arriba
            const searchOptions: SearchOptions<IndexedChunkDocument> = {
                filter: `knowledgeBaseId eq '${knowledgeBaseId}'`,
                top: limit,
                 // Definir los campos a seleccionar
                 select: ["chunkId", "documentId", "knowledgeBaseId", "content"],
                 includeTotalCount: false,
                 // Para búsqueda híbrida (descomentar si se configura en el índice):
                 // queryType: 'semantic',
                 // semanticSearchOptions: { semanticConfigurationName: 'your-semantic-config-name' }
            };


            // 5. Ejecutar la búsqueda vectorial
            this.logger.debug(`Ejecutando búsqueda vectorial en índice ${searchClient.indexName}`);
            // Define todas las opciones directamente en un solo objeto:
            const searchResults: SearchDocumentsResult<IndexedChunkDocument> = await searchClient.search<any>(
                "*", // O `query` para búsqueda híbrida
                {
                    // Opciones generales:
                    filter: `knowledgeBaseId eq '${knowledgeBaseId}'`,
                    top: limit,
                    select: ["chunkId", "documentId", "knowledgeBaseId", "content"],
                    includeTotalCount: false,
                    // Para búsqueda híbrida (opcional):
                    // queryType: 'semantic',
                    // semanticSearchOptions: { semanticConfigurationName: 'your-semantic-config-name' },

                    // Opciones de búsqueda vectorial:
                    vectorSearchOptions: {
                        queries: [
                            {
                                kind: "vector",
                                vector: queryEmbedding,
                                kNearestNeighborsCount: Math.max(limit, 10),
                                fields: ["vector"]
                            }
                        ]
                    }
                }
            );


            // 6. Procesar y filtrar resultados
            const finalResults: SearchResultItem[] = [];
             for await (const result of searchResults.results) {
                 // @search.score indica la relevancia (más alto es mejor)
                 const similarityScore = result.score ?? 0;

                 // Ajusta este umbral según tus pruebas con las puntuaciones de AI Search
                 const effectiveScoreThreshold = this.mapSimilarityToScore(threshold);

                 if (similarityScore >= effectiveScoreThreshold) {
                     // Corrección TS2304: Usar la interfaz definida arriba
                     const document = result.document; // Tipo ya es IndexedChunkDocument
                     const docMetadata = document.metadata ? this.tryParseJson(document.metadata) : undefined;

                     finalResults.push({
                         documentId: document.documentId,
                         chunkId: document.chunkId,
                         title: docMetadata?.originalName || document.documentId || 'Título no disponible',
                         similarity: similarityScore, // Devolver la puntuación directa de AI Search
                         relevanceScore: Math.round(similarityScore * 100), // O un mapeo mejor si es necesario
                         content: includeContent ? document.content : undefined,
                         excerpt: includeContent ? this.generateExcerpt(document.content) : undefined,
                         metadata: docMetadata
                     });
                 }
             }


            this.logger.info(`Búsqueda completada. ${finalResults.length} resultados encontrados superando el umbral efectivo.`);

            return {
                query,
                knowledgeBaseId,
                results: finalResults,
                totalResults: finalResults.length,
            };

        } catch (error: unknown) {
            this.logger.error(`Error al realizar búsqueda en Azure AI Search: "${query}"`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw createAppError(500, `Error al realizar búsqueda: ${errorMessage}`);
        }
    }

    // --- Métodos privados auxiliares ---

    private async generateQueryEmbedding(query: string): Promise<number[]> {
        try {
            return await this.openaiService.getEmbedding(query);
        } catch (error: unknown) {
            this.logger.error("Error al generar embedding para la consulta:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw createAppError(500, `Error al procesar consulta de búsqueda: ${errorMessage}`);
        }
    }

     /**
      * Mapea un umbral de similitud (0-1) a una puntuación esperada de Azure AI Search.
      * ¡ESTA ES UNA ESTIMACIÓN Y DEBE AJUSTARSE!
      */
     private mapSimilarityToScore(similarity: number): number {
         // Devuelve un valor bajo por defecto para no filtrar demasiado agresivamente.
         // Revisa la documentación de Azure AI Search para tu métrica (cosine/dotProduct)
         // y cómo se relaciona el score con la similitud real.
         return 0.4; // Ejemplo: Umbral bajo en la puntuación de AI Search
     }

     private generateExcerpt(content: string | null | undefined, maxLength: number = 200): string {
          if (!content) return '';
          if (content.length <= maxLength) {
              return content;
          }
          const truncated = content.substring(0, maxLength);
          // Intentar cortar en un espacio para no cortar palabras
          const lastSpace = truncated.lastIndexOf(' ');
          if (lastSpace > maxLength * 0.7) { // Si hay espacio razonablemente cerca del final
              return truncated.substring(0, lastSpace) + '...';
          }
          return truncated + '...'; // Si no, cortar directo
      }

      private tryParseJson(jsonString: string | undefined): Record<string, any> | undefined {
           if (!jsonString) return undefined;
           try {
               return JSON.parse(jsonString);
           } catch (e) {
               this.logger.warn(`Error al parsear metadata JSON: ${e}`);
               return undefined; // Devolver undefined en caso de error de parseo
           }
       }
}