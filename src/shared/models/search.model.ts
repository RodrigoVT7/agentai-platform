// src/shared/models/search.model.ts

/**
 * Parámetros para realizar una búsqueda vectorial
 */
export interface SearchQuery {
    /**
     * Texto de la consulta a buscar
     */
    query: string;
    
    /**
     * ID de la base de conocimiento donde buscar
     */
    knowledgeBaseId: string;
    
    /**
     * ID del agente propietario de la base de conocimiento
     */
    agentId: string;
    
    /**
     * Número máximo de resultados a devolver (por defecto: 5)
     */
    limit?: number;
    
    /**
     * Umbral mínimo de similitud de coseno (0-1) (por defecto: 0.7)
     */
    threshold?: number;
    
    /**
     * Si se debe incluir el contenido completo en los resultados (por defecto: true)
     */
    includeContent?: boolean;
  }
  
  /**
   * Coincidencia de vector para búsqueda semántica
   */
  export interface VectorMatch {
    /**
     * ID del documento
     */
    documentId: string;
    
    /**
     * ID del chunk específico
     */
    chunkId: string;
    
    /**
     * Puntuación de similitud de coseno (0-1)
     */
    similarity: number;
    
    /**
     * Contenido del chunk
     */
    content: string;
  }
  
  /**
   * Elemento de resultado de búsqueda enriquecido
   */
  export interface SearchResultItem {
    /**
     * ID del documento
     */
    documentId: string;
    
    /**
     * ID del chunk específico
     */
    chunkId: string;
    
    /**
     * Título del documento
     */
    title: string;
    
    /**
     * Puntuación de similitud de coseno (0-1)
     */
    similarity: number;
    
    /**
     * Puntuación de relevancia normalizada (0-100)
     */
    relevanceScore: number;
    
    /**
     * Contenido completo del chunk (opcional)
     */
    content?: string;
    
    /**
     * Extracto corto para mostrar en resultados
     */
    excerpt?: string;
    
    /**
     * Metadatos adicionales del documento
     */
    metadata?: Record<string, any>;
  }
  
  /**
   * Resultados completos de una búsqueda
   */
  export interface SearchResults {
    /**
     * Consulta original
     */
    query: string;
    
    /**
     * ID de la base de conocimiento
     */
    knowledgeBaseId: string;
    
    /**
     * Resultados de la búsqueda
     */
    results: SearchResultItem[];
    
    /**
     * Número total de resultados encontrados
     */
    totalResults: number;
  }