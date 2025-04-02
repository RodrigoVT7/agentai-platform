// src/shared/handlers/knowledge/documentSearchHandler.ts
import { StorageService } from "../../services/storage.service";
import { OpenAIService } from "../../services/openai.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  SearchQuery, 
  SearchResultItem, 
  SearchResults,
  VectorMatch 
} from "../../models/search.model";

export class DocumentSearchHandler {
  private storageService: StorageService;
  private openaiService: OpenAIService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.storageService = new StorageService();
    this.openaiService = new OpenAIService(this.logger);
  }
  
  /**
   * Ejecuta una búsqueda vectorial sobre la base de conocimiento
   * @param params Parámetros de búsqueda
   * @returns Resultados de la búsqueda
   */
  public async execute(params: SearchQuery): Promise<SearchResults> {
    const { query, knowledgeBaseId, agentId, limit = 5, threshold = 0.7, includeContent = true } = params;
    
    try {
      this.logger.info(`Realizando búsqueda vectorial: "${query}" en base de conocimiento ${knowledgeBaseId}`);
      
      // Generar embedding para la consulta
      const queryEmbedding = await this.generateQueryEmbedding(query);
      
      // Buscar vectores similares en Table Storage
      const matches = await this.findSimilarVectors(queryEmbedding, knowledgeBaseId, threshold, limit);
      
      if (matches.length === 0) {
        this.logger.info(`No se encontraron resultados para la consulta "${query}"`);
        return {
          query,
          knowledgeBaseId,
          results: [],
          totalResults: 0
        };
      }
      
      // Obtener datos completos de los documentos encontrados
      const results = await this.enrichSearchResults(matches, knowledgeBaseId, includeContent);
      
      this.logger.info(`Búsqueda completada. Se encontraron ${results.length} resultados para "${query}"`);
      
      return {
        query,
        knowledgeBaseId,
        results,
        totalResults: results.length,
      };
    } catch (error: unknown) {
      this.logger.error(`Error al realizar búsqueda vectorial: "${query}"`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al realizar búsqueda: ${errorMessage}`);
    }
  }
  
  /**
   * Genera un embedding para la consulta de búsqueda
   */
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
   * Busca vectores similares en la base de datos vectorial
   */
  private async findSimilarVectors(
    queryEmbedding: number[], 
    knowledgeBaseId: string, 
    threshold: number,
    limit: number
  ): Promise<VectorMatch[]> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.VECTORS);
      
      // Obtener todos los vectores para la knowledge base especificada
      const vectors = tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}'` }
      });

      this.logger.info(`vectors: "${JSON.stringify(vectors)}"`);

      
      const matches: VectorMatch[] = [];
      
      // Procesar cada vector y calcular similitud
      for await (const vector of vectors) {
        try {
          // Extraer el vector de embedding
          const embedding = JSON.parse(vector.vector as string) as number[];
          
          // Calcular similitud de coseno
          const similarity = this.calculateCosineSimilarity(queryEmbedding, embedding);
          
          // Si supera el umbral, añadir a los resultados
          if (similarity >= threshold) {
            matches.push({
              documentId: vector.documentId as string,
              chunkId: vector.chunkId as string,
              similarity,
              content: vector.content as string
            });
          }
        } catch (parseError) {
          this.logger.warn(`Error al procesar vector para ${vector.chunkId}:`, parseError);
          // Continuar con el siguiente vector
          continue;
        }
      }
      
      // Ordenar por similitud (mayor primero) y limitar resultados
      return matches
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
    } catch (error: unknown) {
      this.logger.error("Error al buscar vectores similares:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al buscar documentos similares: ${errorMessage}`);
    }
  }
  
  /**
   * Enriquece los resultados con información adicional de los documentos
   */
  private async enrichSearchResults(
    matches: VectorMatch[], 
    knowledgeBaseId: string,
    includeContent: boolean
  ): Promise<SearchResultItem[]> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      const results: SearchResultItem[] = [];
      
      // Obtener información detallada de cada documento
      for (const match of matches) {
        try {
          // Buscar el documento original
          const document = await tableClient.getEntity(knowledgeBaseId, match.documentId);
          
          // Crear resultado enriquecido
          const resultItem: SearchResultItem = {
            documentId: match.documentId,
            chunkId: match.chunkId,
            title: document.name as string,
            similarity: match.similarity,
            relevanceScore: Math.round(match.similarity * 100)
          };
          
          // Incluir contenido si se solicitó
          if (includeContent) {
            resultItem.content = match.content;
            
            // Generar un extracto corto para mostrar como preview
            resultItem.excerpt = this.generateExcerpt(match.content);
          }
          
          // Añadir metadatos si existen
          if (document.metadata) {
            try {
              const metadata = JSON.parse(document.metadata as string);
              resultItem.metadata = metadata;
            } catch (parseError) {
              this.logger.warn(`Error al parsear metadatos para ${match.documentId}:`, parseError);
            }
          }
          
          results.push(resultItem);
        } catch (documentError) {
          this.logger.warn(`Error al obtener documento ${match.documentId}:`, documentError);
          // Añadir resultado parcial con la información disponible
          results.push({
            documentId: match.documentId,
            chunkId: match.chunkId,
            title: 'Documento no encontrado',
            similarity: match.similarity,
            relevanceScore: Math.round(match.similarity * 100),
            content: includeContent ? match.content : undefined,
            excerpt: includeContent ? this.generateExcerpt(match.content) : undefined
          });
        }
      }
      
      return results;
    } catch (error: unknown) {
      this.logger.error("Error al enriquecer resultados de búsqueda:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al procesar resultados de búsqueda: ${errorMessage}`);
    }
  }
  
  /**
   * Calcula la similitud de coseno entre dos vectores
   */
  private calculateCosineSimilarity(vectorA: number[], vectorB: number[]): number {
    if (vectorA.length !== vectorB.length) {
      throw new Error('Los vectores deben tener la misma dimensión para calcular similitud');
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i];
      normA += vectorA[i] * vectorA[i];
      normB += vectorB[i] * vectorB[i];
    }
    
    const normAValue = Math.sqrt(normA);
    const normBValue = Math.sqrt(normB);
    
    if (normAValue === 0 || normBValue === 0) {
      return 0;
    }
    
    return dotProduct / (normAValue * normBValue);
  }
  
  /**
   * Genera un extracto corto del contenido para mostrar como preview
   */
  private generateExcerpt(content: string, maxLength: number = 200): string {
    if (!content) return '';
    
    // Si el contenido es corto, devolverlo completo
    if (content.length <= maxLength) {
      return content;
    }
    
    // Buscar un punto final cerca del límite para cortar en una frase completa
    const truncated = content.substring(0, maxLength);
    const lastPeriod = truncated.lastIndexOf('.');
    
    if (lastPeriod > maxLength * 0.5) {
      // Si encontramos un punto final después de al menos la mitad del extracto,
      // cortar ahí para tener una frase completa
      return truncated.substring(0, lastPeriod + 1);
    }
    
    // Si no hay un punto final adecuado, cortar en el máximo y añadir puntos suspensivos
    return truncated + '...';
  }
}