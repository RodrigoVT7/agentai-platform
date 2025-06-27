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
import { 
  QueryUnderstanding, 
  EnhancedSearchQuery,
  ContextAnalysis, 
  EnhancedQueryAnalysis
} from "../../models/query-analysis.model";
import { TextAnalysisUtils } from "../../utils/text-analysis.utils";


export class DocumentSearchHandler {
    private openaiService: OpenAIService;
    private aiSearchService: AzureAiSearchService;
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || createLogger();
        this.openaiService = new OpenAIService(this.logger);
        this.aiSearchService = new AzureAiSearchService(this.logger);
    }


// ACTUALIZACIÓN para src/shared/handlers/knowledge/documentSearchHandler.ts

// AÑADIR este método privado a la clase DocumentSearchHandler:

private sanitizeJsonResponse(content: string): string {
  if (!content) return content;
  
  try {
    // Busca el inicio del JSON, ya sea con '{' o '['
    const jsonStart = content.indexOf('{');
    const arrayStart = content.indexOf('[');
    
    let firstIndex = -1;

    if (jsonStart === -1) {
      firstIndex = arrayStart;
    } else if (arrayStart === -1) {
      firstIndex = jsonStart;
    } else {
      firstIndex = Math.min(jsonStart, arrayStart);
    }
    
    if (firstIndex === -1) {
      this.logger.warn('No se encontró un inicio de JSON ({ o [) en el contenido.');
      return ''; // Devuelve vacío si no hay JSON
    }

    // Busca el final del JSON que corresponde al inicio encontrado
    const lastBrace = content.lastIndexOf('}');
    const lastBracket = content.lastIndexOf(']');
    
    let lastIndex = -1;

    // Determina el carácter de cierre correcto basado en el de apertura
    if (content.substring(firstIndex).startsWith('[')) {
        lastIndex = lastBracket;
    } else {
        lastIndex = lastBrace;
    }

    if (lastIndex === -1 || lastIndex < firstIndex) {
      this.logger.warn('No se encontró un final de JSON (} o ]) válido después del inicio.');
      return ''; // Devuelve vacío si el JSON es inválido
    }
    
    // Extrae la subcadena que contiene el JSON
    const jsonString = content.substring(firstIndex, lastIndex + 1);
    
    // Valida que el string extraído es realmente un JSON parseable (lanzará un error si no lo es)
    JSON.parse(jsonString);

    return jsonString;

  } catch (error) {
    this.logger.warn('Error sanitizando o validando la respuesta JSON:', error);
    return ''; 
  }
}

// REEMPLAZAR el método understandQuery con esta versión mejorada:

private async understandQuery(query: string): Promise<QueryUnderstanding> {
  try {
    // 🔥 NUEVO: FILTRO TEMPRANO PARA CONFIRMACIONES
    const queryTrimmed = query.trim();
    
    // Patrones que NO deben analizarse con OpenAI
    const skipAnalysisPatterns = [
      /^(si|sí|no|ok|okay|dale|perfecto|correcto|adelante|cambiala|modificala)$/i,
      /^(yes|no|change it|modify it|cancel it|delete it)$/i,
      /^[a-zA-Z\s]{1,5}$/,  // Muy cortos
      /^(👍|👎|✅|❌)$/
    ];
    
    const shouldSkipAnalysis = skipAnalysisPatterns.some(pattern => pattern.test(queryTrimmed));
    
    if (shouldSkipAnalysis) {
      this.logger.info(`🚫 Saltando análisis OpenAI para confirmación: "${queryTrimmed}"`);
      return this.getFallbackAnalysis(query);
    }
    
    // También saltar si es muy corto
    if (queryTrimmed.length < 4) {
      this.logger.info(`🚫 Saltando análisis OpenAI para query muy corta: "${queryTrimmed}"`);
      return this.getFallbackAnalysis(query);
    }

    // Usar OpenAI para análisis inteligente de la query
    const analysisPrompt = `Analiza esta consulta del usuario y determina sus características:

CONSULTA: "${query}"

Responde SOLO con un JSON válido (sin explicaciones adicionales):
{
  "requiresComparison": boolean,
  "requiresRanking": boolean,
  "requiresCalculation": boolean,
  "searchType": "simple" | "comparative" | "superlative" | "analytical",
  "entities": ["entidad1", "entidad2"],
  "keyTerms": ["término1", "término2"],
  "complexity": "simple" | "complex",
  "confidence": 0.9,
  "suggestedSearchQueries": ["query1", "query2"]
}

CRITERIOS:
- requiresComparison: true si busca comparar opciones (vs, entre, diferencia)
- requiresRanking: true si busca extremos (más, menos, mejor, peor, máximo, mínimo, mayor, menor)
- requiresCalculation: true si necesita cálculos (total, suma, promedio, cantidad)
- searchType: tipo de búsqueda más apropiado
- entities: sustantivos/objetos principales de la consulta
- keyTerms: palabras clave importantes para la búsqueda
- complexity: simple para preguntas directas, complex para multi-parte
- confidence: qué tan seguro estás del análisis (0-1)
- suggestedSearchQueries: 2-3 variaciones de búsqueda optimizadas`;

    const response = await this.openaiService.getChatCompletionWithTools([
      { role: 'system', content: analysisPrompt },
      { role: 'user', content: query }
    ], [], 0.1); // Temperatura baja para consistencia

    if (!response.content) {
      this.logger.warn(`OpenAI devolvió contenido vacío para query "${query}"`);
      return this.getFallbackAnalysis(query);
    }

    // 🔥 SANITIZAR RESPUESTA ANTES DE PARSEAR
    const sanitizedContent = this.sanitizeJsonResponse(response.content);
    
    if (!sanitizedContent) {
      this.logger.warn(`Contenido sanitizado vacío para query "${query}"`);
      return this.getFallbackAnalysis(query);
    }

    try {
      // Parsear respuesta JSON sanitizada
      const analysis: EnhancedQueryAnalysis = JSON.parse(sanitizedContent);
      
      // Convertir a formato QueryUnderstanding existente
      return this.convertToQueryUnderstanding(analysis, query);
      
    } catch (parseError) {
      this.logger.warn(`Error parseando JSON sanitizado de OpenAI para query "${query}":`, parseError);
      this.logger.debug(`Contenido original: "${response.content}"`);
      this.logger.debug(`Contenido sanitizado: "${sanitizedContent}"`);
      return this.getFallbackAnalysis(query);
    }

  } catch (error) {
    this.logger.warn(`Error en análisis OpenAI de query "${query}":`, error);
    return this.getFallbackAnalysis(query);
  }
}

// Nuevo método: Convertir análisis mejorado al formato existente
private convertToQueryUnderstanding(
  analysis: EnhancedQueryAnalysis, 
  query: string
): QueryUnderstanding {
  const intents: string[] = [];
  
  if (analysis.requiresComparison) intents.push('comparative');
  if (analysis.requiresRanking) intents.push('superlative');
  if (analysis.requiresCalculation) intents.push('aggregation');
  
  return {
    intents,
    entities: analysis.entities,
    modifiers: analysis.keyTerms,
    requiresCalculation: analysis.requiresCalculation,
    complexity: analysis.complexity,
    language: TextAnalysisUtils.detectLanguage(query),
    confidence: analysis.confidence,
    // Añadir campos nuevos
    searchType: analysis.searchType,
    suggestedQueries: analysis.suggestedSearchQueries
  };
}

// Nuevo método: Análisis de fallback si OpenAI falla
private getFallbackAnalysis(query: string): QueryUnderstanding {
  const queryLower = query.toLowerCase();
  
  // Detección básica de palabras clave como backup
  const rankingWords = ['más', 'mas', 'menos', 'mejor', 'peor', 'mayor', 'menor', 'máximo', 'mínimo', 'barato', 'caro'];
  const comparisonWords = ['comparar', 'vs', 'versus', 'entre', 'diferencia'];
  const calculationWords = ['total', 'suma', 'promedio', 'cantidad', 'cuántos', 'cuantos'];
  
  const requiresRanking = rankingWords.some(word => queryLower.includes(word));
  const requiresComparison = comparisonWords.some(word => queryLower.includes(word));
  const requiresCalculation = calculationWords.some(word => queryLower.includes(word));
  
  const intents: string[] = [];
  if (requiresRanking) intents.push('superlative');
  if (requiresComparison) intents.push('comparative');
  if (requiresCalculation) intents.push('aggregation');
  
  return {
    intents,
    entities: TextAnalysisUtils.extractEntities(query),
    modifiers: [],
    requiresCalculation,
    complexity: intents.length > 1 ? 'complex' : 'simple',
    language: TextAnalysisUtils.detectLanguage(query),
    confidence: 0.6,
    searchType: requiresRanking ? 'superlative' : 'simple',
    suggestedQueries: [query]
  };
}

// ACTUALIZAR en documentSearchHandler.ts
// Método generateSearchQueries - VERSIÓN GENÉRICA MULTIPLATAFORMA

private generateSearchQueries(
  originalQuery: string,
  understanding: QueryUnderstanding
): EnhancedSearchQuery[] {
  const queries: EnhancedSearchQuery[] = [];
  
  // 1. Query original siempre primero
  queries.push({
    text: originalQuery,
    weight: 1.0,
    metadata: { isOriginal: true }
  });
  
  // 2. Usar queries sugeridas por OpenAI si están disponibles
  if (understanding.suggestedQueries && understanding.suggestedQueries.length > 1) {
    understanding.suggestedQueries.slice(1).forEach((suggestedQuery, index) => {
      queries.push({
        text: suggestedQuery,
        weight: 0.8 - (index * 0.1),
        metadata: { isAiSuggested: true }
      });
    });
  }
  
  // 3. **NUEVA LÓGICA GENÉRICA PARA CONSULTAS COMPARATIVAS/SUPERLATIVAS**
  if (understanding.searchType === 'superlative' || understanding.intents.includes('superlative')) {
    
    // Generar búsquedas para obtener MÚLTIPLES DATOS COMPARABLES
    
    // Query 1: Buscar datos estructurados/tablas
    const structuredQuery = this.generateStructuredDataQuery(understanding.entities);
    if (structuredQuery) {
      queries.push({
        text: structuredQuery,
        weight: 1.2, // Peso ALTO para datos estructurados
        metadata: { focus: 'structured_data', searchType: 'superlative' }
      });
    }
    
    // Query 2: Buscar listas/múltiples opciones
    const multipleOptionsQuery = this.generateMultipleOptionsQuery(understanding.entities, understanding.modifiers);
    if (multipleOptionsQuery) {
      queries.push({
        text: multipleOptionsQuery,
        weight: 1.1,
        metadata: { focus: 'multiple_options', searchType: 'superlative' }
      });
    }
    
    // Query 3: Buscar usando términos comparativos
    const comparativeQuery = this.generateComparativeQuery(understanding.entities, understanding.modifiers);
    if (comparativeQuery) {
      queries.push({
        text: comparativeQuery,
        weight: 1.0,
        metadata: { focus: 'comparative_terms', searchType: 'superlative' }
      });
    }
    
    // Query 4: Buscar rangos/variaciones
    const rangeQuery = this.generateRangeQuery(understanding.entities, understanding.modifiers);
    if (rangeQuery) {
      queries.push({
        text: rangeQuery,
        weight: 0.9,
        metadata: { focus: 'ranges', searchType: 'superlative' }
      });
    }
  }
  
  if (understanding.searchType === 'comparative') {
    const comparisonQuery = understanding.entities.join(' ') + ' opciones lista comparación diferencias';
    queries.push({
      text: comparisonQuery,  
      weight: 0.7,
      metadata: { focus: 'comparison' }
    });
  }
  
  return queries;
}

// NUEVOS MÉTODOS GENÉRICOS PARA GENERAR QUERIES DE BÚSQUEDA

private generateStructuredDataQuery(entities: string[]): string | null {
  if (!entities || entities.length === 0) return null;
  
  // Términos genéricos que indican datos estructurados
  const structureTerms = [
    'tabla', 'lista', 'datos', 'información', 'completa', 'todos', 'todas',
    'opciones', 'disponible', 'catálogo', 'inventario', 'resumen'
  ];
  
  // Combinar entidades principales con términos de estructura
  const mainEntities = entities.slice(0, 2); // Tomar máximo 2 entidades principales
  const selectedStructureTerms = structureTerms.slice(0, 3); // Tomar 3 términos de estructura
  
  return [...mainEntities, ...selectedStructureTerms].join(' ');
}

private generateMultipleOptionsQuery(entities: string[], modifiers: string[] = []): string | null {
  if (!entities || entities.length === 0) return null;
  
  // Términos que sugieren múltiples opciones
  const multipleTerms = [
    'varios', 'múltiples', 'diferentes', 'variedad', 'selección', 'gama',
    'desde', 'hasta', 'entre', 'rango', 'opciones', 'alternativas'
  ];
  
  const mainEntity = entities[0]; // Entidad principal
  const relevantModifiers = modifiers?.slice(0, 2) || []; // Hasta 2 modificadores
  const selectedMultipleTerms = multipleTerms.slice(0, 2); // 2 términos múltiples
  
  return [mainEntity, ...relevantModifiers, ...selectedMultipleTerms].join(' ');
}

private generateComparativeQuery(entities: string[], modifiers: string[] = []): string | null {
  if (!entities || entities.length === 0) return null;
  
  // Términos comparativos genéricos
  const comparativeTerms = [
    'mejor', 'peor', 'mayor', 'menor', 'más', 'menos', 
    'superior', 'inferior', 'máximo', 'mínimo', 'óptimo',
    'ideal', 'recomendado', 'popular', 'económico', 'premium'
  ];
  
  const mainEntity = entities[0];
  const relevantModifiers = modifiers?.slice(0, 1) || [];
  const selectedComparativeTerms = comparativeTerms.slice(0, 3);
  
  return [mainEntity, ...relevantModifiers, ...selectedComparativeTerms].join(' ');
}

private generateRangeQuery(entities: string[], modifiers: string[] = []): string | null {
  if (!entities || entities.length === 0) return null;
  
  // Términos que indican rangos o variaciones
  const rangeTerms = [
    'desde', 'hasta', 'entre', 'rango', 'variación', 'diferencia',
    'escalas', 'niveles', 'categorías', 'tipos', 'clases', 'grupos'
  ];
  
  const mainEntity = entities[0];
  const relevantModifiers = modifiers?.slice(0, 1) || [];
  const selectedRangeTerms = rangeTerms.slice(0, 2);
  
  return [mainEntity, ...relevantModifiers, ...selectedRangeTerms].join(' ');
}

// ACTUALIZAR también el método execute para aumentar el límite de chunks cuando es superlativo
public async execute(params: SearchQuery): Promise<SearchResults> {
  const { query, knowledgeBaseId, limit = 5, threshold = 0.7, includeContent = true } = params;
  
  try {
    this.logger.info(`Búsqueda inteligente: "${query}" en KB ${knowledgeBaseId}`);
    
    // 1. Entender la consulta
    const queryUnderstanding = await this.understandQuery(query);
    this.logger.debug('Query understanding:', queryUnderstanding);
    
    // 2. Generar múltiples consultas de búsqueda
    const searchQueries = this.generateSearchQueries(query, queryUnderstanding);
    this.logger.debug(`Generadas ${searchQueries.length} variaciones de búsqueda`);
    
    // 3. **AJUSTAR LÍMITE DINÁMICAMENTE PARA CONSULTAS COMPARATIVAS**
    let dynamicLimit = limit;
    if (queryUnderstanding.searchType === 'superlative' || queryUnderstanding.intents.includes('superlative')) {
      dynamicLimit = Math.max(limit * 2, 10); // Mínimo 10 chunks para comparaciones
      this.logger.debug(`Aumentando límite a ${dynamicLimit} para consulta superlativa`);
    }
    
    // 4. Ejecutar búsquedas
    const allResults: SearchResultItem[] = [];
    const processedIds = new Set<string>();
    
    for (const searchQuery of searchQueries) {
      const embedding = await this.generateQueryEmbedding(searchQuery.text);
      
      const searchOptions: SearchOptions<any> = {
        filter: `knowledgeBaseId eq '${knowledgeBaseId}'`,
        top: Math.ceil(dynamicLimit * searchQuery.weight * 2), // Más resultados por query
        select: ["chunkId", "documentId", "knowledgeBaseId", "content", "blockType", "isPriceTable", "isComparisonCritical"],
        includeTotalCount: false,
        vectorSearchOptions: {
          queries: [{
            kind: "vector",
            vector: embedding,
            kNearestNeighborsCount: Math.max(dynamicLimit * 3, 30), // Más candidatos
            fields: ["vector"]
          }]
        }
      };
      
      const searchClient = this.aiSearchService.getSearchClient();
      const searchResults = await searchClient.search("*", searchOptions);
      
      for await (const result of searchResults.results) {
        if (!processedIds.has(result.document.chunkId)) {
          processedIds.add(result.document.chunkId);
          
          const similarity = result.score ?? 0;
          
          allResults.push({
            documentId: result.document.documentId,
            chunkId: result.document.chunkId,
            title: `Documento ${result.document.documentId}`,
            similarity: similarity,
            relevanceScore: Math.round(similarity * 100),
            content: includeContent ? result.document.content : undefined,
            excerpt: includeContent ? this.generateContextualExcerpt(result.document.content, query) : undefined,
            metadata: { // Aquí es donde mapeas a SearchResultItem.metadata
              blockType: result.document.blockType,
              isPriceTable: result.document.isPriceTable,
              isComparisonCritical: result.document.isComparisonCritical,
              // ... cualquier otro metadata que quieras pasar
              matchedQuery: searchQuery.text,
              queryType: searchQuery.metadata?.focus || 'general' // searchQuery.metadata es de EnhancedSearchQuery
          }
          });
        }
      }
    }
    
    // 5. Re-rankear resultados inteligentemente
    const rerankedResults = await this.intelligentReranking(
      allResults,
      query,
      queryUnderstanding
    );
    
    // 6. Filtrar por threshold ajustado
    const filteredResults = rerankedResults.filter(
      result => result.similarity >= this.adjustThreshold(threshold, queryUnderstanding)
    );
    
    this.logger.info(`Búsqueda completada: ${filteredResults.length} resultados relevantes de ${allResults.length} totales`);
    
    // 7. **PARA CONSULTAS SUPERLATIVAS, DEVOLVER MÁS CHUNKS**
    let currentFinalLimit = limit; // params.limit, que por defecto es 5
    if (queryUnderstanding.searchType === 'superlative') {
        currentFinalLimit = Math.max(limit, 8);
    } else if (queryUnderstanding.searchType === 'list_all') {
        // Para list_all, podríamos querer más chunks si la info está dispersa,
        // pero si el chunk "price_table_sorted" es bueno y único, 1 sería suficiente *si es el correcto*.
        // Por seguridad, mantenlo similar al superlativo o un poco más si sospechas dispersión.
        // Sin embargo, la clave es que el re-ranking ponga el chunk correcto al principio.
        currentFinalLimit = Math.max(limit, 5); // O incluso solo `limit`, confiando en el re-ranking.
    }
    // ...
    const resultsToReturn = filteredResults.slice(0, currentFinalLimit);
    
    this.logger.info(`[${knowledgeBaseId}] DocumentSearchHandler: Query: "${query}", Understood SearchType: "${queryUnderstanding.searchType}", Final Limit: ${currentFinalLimit}`);
this.logger.info(`[${knowledgeBaseId}] DocumentSearchHandler: Retornando ${resultsToReturn.length} chunks.`);
resultsToReturn.forEach((res, idx) => {
    this.logger.debug(`[${knowledgeBaseId}] Chunk ${idx + 1} para LLM: chunkId: ${res.chunkId}, docId: ${res.documentId}, score: ${res.similarity}, blockType: ${res.metadata?.blockType}`);
    this.logger.debug(`[${knowledgeBaseId}] Chunk ${idx + 1} Content Snippet: ${(res.content || "").substring(0, 250)}...`); // Log un snippet más grande
    if ((res.content || "").includes("[PRECIOS ORDENADOS DE MENOR A MAYOR]")) {
        this.logger.info(`[${knowledgeBaseId}] !!! ENCONTRADO CHUNK CON TODOS LOS PRECIOS ORDENADOS: ${res.chunkId} !!!`);
    }
});

    return {
      query,
      knowledgeBaseId,
      results: resultsToReturn,
      totalResults: filteredResults.length,
    };
    
  } catch (error) {
    this.logger.error(`Error en búsqueda inteligente:`, error);
    throw error;
  }
}

// 4. ACTUALIZAR: Mejorar el re-ranking con el análisis
// En src/shared/handlers/knowledge/documentSearchHandler.ts

private async intelligentReranking(
    results: SearchResultItem[],
    originalQuery: string,
    understanding: QueryUnderstanding
): Promise<SearchResultItem[]> {
    const scoredResults = results.map(result => {
        let adjustedScore = result.similarity;
        const content = result.content; // Puede ser undefined, string vacío, o string con contenido.
        const metadata = result.metadata || {};

        // --- Lógica Unificada para Intención de Listar Todo ---
        const isListAllQueryIntent = 
            understanding.searchType === 'list_all' || 
            (understanding.intents && understanding.intents.includes('list_all')) ||
            (understanding.modifiers && understanding.modifiers.includes('lista'));

        if (isListAllQueryIntent) {
            let listBoostApplied = false;
            if (metadata.blockType === 'price_table_sorted') {
                adjustedScore *= 3.0; // Impulso máximo para el chunk perfectamente procesado
                this.logger.debug(`[Reranking] MAX BOOST (x3.0) para 'price_table_sorted' chunk ${result.chunkId}. Score: ${adjustedScore}`);
                listBoostApplied = true;
            } else if (metadata.isPriceTable === true) {
                adjustedScore *= 2.0; // Impulso fuerte si es una tabla de precios
                this.logger.debug(`[Reranking] Fuerte boost (x2.0) para 'isPriceTable' chunk ${result.chunkId}. Score: ${adjustedScore}`);
                listBoostApplied = true;
            } else if (metadata.blockType === 'table' || metadata.blockType === 'list') {
                adjustedScore *= 1.5; // Impulso general para otras tablas o listas
                this.logger.debug(`[Reranking] Boost general (x1.5) para tabla/lista (metadata) chunk ${result.chunkId}. Score: ${adjustedScore}`);
                listBoostApplied = true;
            }

            // Verificación adicional basada en contenido si existe y no se aplicó un boost fuerte por metadata
            if (content) { // Solo si hay contenido para analizar
                const hasPriceOrderMarker = content.includes('[PRECIOS ORDENADOS DE MENOR A MAYOR]');
                const hasGenericListMarker = content.includes('[LISTA COMPLETA ORDENADA]');

                if (hasPriceOrderMarker && metadata.blockType !== 'price_table_sorted') { // Si el marker está pero no fue detectado por metadata como EL chunk ideal
                    adjustedScore *= 1.8; // Un buen impulso si se detecta por contenido
                    this.logger.debug(`[Reranking] Boost (x1.8) por contenido '[PRECIOS ORDENADOS...]' chunk ${result.chunkId}. Score: ${adjustedScore}`);
                    listBoostApplied = true;
                } else if (hasGenericListMarker && !listBoostApplied) { // Aplicar si otro boost de lista no se aplicó
                    adjustedScore *= 1.6; 
                    this.logger.debug(`[Reranking] Boost (x1.6) por contenido '[LISTA COMPLETA...]' chunk ${result.chunkId}. Score: ${adjustedScore}`);
                    // listBoostApplied = true; // Podrías marcarlo si consideras este suficiente
                }
            }
        }

        // --- Lógica Dependiente del Contenido ---
        // Solo ejecutar si 'content' es una cadena no vacía.
        if (content && content.trim() !== "") {
            // Bonificaciones para 'superlative' (cuando NO es primariamente un list_all o si quieres que se combinen)
            // Si es 'superlative' Y 'list_all', el boost de list_all (ej. x3.0) debería tener más peso.
            // Puedes decidir si los boosts son aditivos o si uno tiene precedencia.
            // Por ahora, se aplicarán secuencialmente si ambas condiciones de 'understanding' se cumplen.
            if (understanding.searchType === 'superlative' || (understanding.intents && understanding.intents.includes('superlative'))) {
                const contentAnalysis = this.analyzeResultContent(content); // Asume que analyzeResultContent maneja strings
                
                if (contentAnalysis.hasNumericData) {
                    adjustedScore *= 1.4;
                }
                if (contentAnalysis.hasRankingPotential) {
                    adjustedScore *= 1.3;
                }
                
                const queryTerms = (understanding.entities || []).concat(understanding.modifiers || []);
                const matchingTerms = queryTerms.filter(term => 
                    content.toLowerCase().includes(term.toLowerCase()) // Seguro porque 'content' está verificado
                ).length;
                adjustedScore *= (1 + (matchingTerms * 0.15));
            }

            // Bonificación para 'requiresCalculation'
            if (understanding.requiresCalculation && this.detectNumericData(content)) { // Asume que detectNumericData maneja strings
                adjustedScore *= 1.25;
            }
        } else {
            // Si no hay contenido, los boosts basados en metadata (si los hubo) se mantienen.
            // Puedes decidir si penalizar chunks sin contenido si no deberían existir.
            if (isListAllQueryIntent && !metadata.blockType) { // Si se esperaba una lista pero el chunk no tiene contenido ni metadata útil
                 // adjustedScore *= 0.8; // Ejemplo de penalización leve
                 this.logger.debug(`[Reranking] Chunk ${result.chunkId} sin contenido y sin metadata de tipo lista relevante para una consulta de listado.`);
            }
        }
        
        // Almacenar el score ajustado directamente en el objeto para ordenar
        // Esto es una forma común, pero asegúrate que 'result' pueda tener esta propiedad o usa un Map.
        (result as any).adjustedScore = adjustedScore;
        return result; // Devolver el objeto 'result' modificado
    });

    // Ordenar por el score ajustado que se añadió a cada objeto
    scoredResults.sort((a, b) => ((b as any).adjustedScore ?? 0) - ((a as any).adjustedScore ?? 0));

    // Limpiar el score temporal antes de diversificar y retornar
    const cleanedResults = scoredResults.map(r => {
        const { adjustedScore, ...rest } = r as any; // Quitar la propiedad temporal
        return rest as SearchResultItem; // Asegurar que el tipo de retorno sea SearchResultItem
    });
    
    return this.diversifyResults(cleanedResults);
}

private analyzeResultContent(content: string): any {
  const analysis = {
    hasNumericData: false,
    hasMultipleItems: false,
    hasRankingPotential: false,
    structureQuality: 'low' as 'low' | 'medium' | 'high'
  };
  
  if (!content) return analysis;
  
  // Detectar datos numéricos
  const numbers = TextAnalysisUtils.extractNumbers(content);
  analysis.hasNumericData = numbers.length > 0;
  
  // Detectar múltiples items (para comparaciones)
  const lines = content.split('\n');
  const patterns = new Map<string, number>();
  
  lines.forEach(line => {
    const linePattern = this.getLinePattern(line);
    if (linePattern) {
      patterns.set(linePattern, (patterns.get(linePattern) || 0) + 1);
    }
  });
  
  // Si hay patrones repetidos, hay múltiples items
  analysis.hasMultipleItems = Array.from(patterns.values()).some(count => count > 2);
  
  // Potencial de ranking (múltiples números + items)
  analysis.hasRankingPotential = analysis.hasNumericData && analysis.hasMultipleItems;
  
  // Calidad de estructura
  const structure = this.evaluateContentStructure(content);
  analysis.structureQuality = structure.quality;
  
  return analysis;
}

private getLinePattern(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 10) return null;
  
  // Crear un patrón genérico reemplazando valores específicos
  let pattern = trimmed
    .replace(/\d+([.,]\d+)?/g, 'NUM')
    .replace(/\$\s*NUM/g, '$NUM')
    .replace(/NUM\s*%/g, 'NUM%')
    .replace(/"[^"]+"/g, 'STR')
    .replace(/'[^']+'/g, 'STR')
    .replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g, 'NAME');
  
  // Si el patrón es muy genérico, no es útil
  if (pattern.match(/^(NUM|STR|NAME)$/)) return null;
  
  return pattern;
}

private evaluateContentStructure(content: string): { quality: 'low' | 'medium' | 'high' } {
  const lines = content.split('\n').filter(l => l.trim());
  
  if (lines.length < 3) return { quality: 'low' };
  
  // Evaluar consistencia de formato
  const formats = lines.map(line => TextAnalysisUtils.getLineFormat(line));
  const hasConsistentFormat = formats.filter(f => f.hasSeparator).length > lines.length * 0.5;
  
  // Evaluar presencia de headers o estructura
  const hasHeaders = lines.slice(0, 3).some(line => TextAnalysisUtils.looksLikeHeader(line));
  
  // Evaluar organización
  const hasLists = lines.filter(line => /^[\s\-\*\d]+\.?\s/.test(line)).length > lines.length * 0.3;
  const hasKeyValues = lines.filter(line => TextAnalysisUtils.looksLikeKey(line)).length > lines.length * 0.3;
  
  if (hasConsistentFormat && (hasHeaders || hasLists || hasKeyValues)) {
    return { quality: 'high' };
  } else if (hasConsistentFormat || hasHeaders || hasLists || hasKeyValues) {
    return { quality: 'medium' };
  }
  
  return { quality: 'low' };
}

private diversifyResults(results: any[]): any[] {
  const diversified: any[] = [];
  const seenDocuments = new Map<string, number>();
  
  // Primera pasada: tomar los mejores de cada documento
  results.forEach(result => {
    const docCount = seenDocuments.get(result.documentId) || 0;
    
    // Permitir máximo 2 chunks del mismo documento en top results
    if (docCount < 2) {
      diversified.push(result);
      seenDocuments.set(result.documentId, docCount + 1);
    }
  });
  
  // Si necesitamos más resultados, añadir los restantes
  if (diversified.length < results.length) {
    results.forEach(result => {
      if (!diversified.includes(result)) {
        diversified.push(result);
      }
    });
  }
  
  return diversified;
}

private generateContextualExcerpt(content: string, query: string): string {
 if (!content) return '';
 
 const maxLength = 300;
 const queryTerms = query.toLowerCase().split(/\s+/);
 const sentences = content.split(/[.!?]+/).filter(s => s.trim());
 
 // Buscar la oración más relevante
 let bestSentence = '';
 let bestScore = 0;
 
 sentences.forEach(sentence => {
   const sentenceLower = sentence.toLowerCase();
   let score = 0;
   
   // Contar coincidencias de términos
   queryTerms.forEach(term => {
     if (sentenceLower.includes(term)) {
       score += 2;
     }
   });
   
   // Bonus si tiene números (para queries numéricas)
   if (TextAnalysisUtils.extractNumbers(sentence).length > 0) {
     score += 1;
   }
   
   if (score > bestScore) {
     bestScore = score;
     bestSentence = sentence;
   }
 });
 
 // Si encontramos una oración relevante, usarla como base
 if (bestSentence && bestScore > 0) {
   const sentenceIndex = content.indexOf(bestSentence);
   const start = Math.max(0, sentenceIndex - 50);
   const end = Math.min(content.length, sentenceIndex + bestSentence.length + 50);
   
   let excerpt = content.substring(start, end).trim();
   
   if (start > 0) excerpt = '...' + excerpt;
   if (end < content.length) excerpt = excerpt + '...';
   
   return excerpt;
 }
 
 // Fallback: usar el inicio del contenido
 return this.generateExcerpt(content, maxLength);
}

private adjustThreshold(baseThreshold: number, understanding: QueryUnderstanding): number {
 let adjusted = baseThreshold;
 
 // Ajustar threshold basado en la complejidad de la query
 if (understanding.complexity === 'complex') {
   adjusted *= 0.9; // Ser más permisivo con queries complejas
 }
 
 if (understanding.requiresCalculation) {
   adjusted *= 0.85; // Ser más permisivo cuando se necesitan datos numéricos
 }
 
 // Nunca bajar demasiado el threshold
 return Math.max(adjusted, 0.5);
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

private detectNumericData(content: string): boolean {
  const numbers = TextAnalysisUtils.extractNumbers(content);
  return numbers.length > 0;
}

}