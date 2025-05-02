// src/shared/services/azureAiSearch.service.ts
import { SearchClient, AzureKeyCredential } from "@azure/search-documents";
import { AZURE_SEARCH_CONFIG } from "../constants";
import { Logger, createLogger } from "../utils/logger";

export class AzureAiSearchService {
    private searchClient: SearchClient<any>; // Usa 'any' o define tu tipo de documento del índice
    private adminClient: SearchClient<any>; // Cliente con clave de admin para indexar
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || createLogger();

        if (!AZURE_SEARCH_CONFIG.ENDPOINT || !AZURE_SEARCH_CONFIG.INDEX_NAME) {
            const errorMsg = "Azure AI Search Endpoint o Index Name no configurados.";
            this.logger.error(errorMsg);
            throw new Error(errorMsg);
        }

        // Cliente para consultas (solo necesita Query Key)
        if (AZURE_SEARCH_CONFIG.QUERY_KEY) {
            this.searchClient = new SearchClient(
                AZURE_SEARCH_CONFIG.ENDPOINT,
                AZURE_SEARCH_CONFIG.INDEX_NAME,
                new AzureKeyCredential(AZURE_SEARCH_CONFIG.QUERY_KEY)
            );
        } else {
            this.logger.warn("Azure AI Search Query Key no configurada. El cliente de búsqueda no estará disponible.");
            // @ts-ignore // Asignar null o manejar de otra forma si es estrictamente necesario
            this.searchClient = null;
        }

        // Cliente para indexación (necesita Admin Key)
        if (AZURE_SEARCH_CONFIG.ADMIN_KEY) {
             this.adminClient = new SearchClient(
                 AZURE_SEARCH_CONFIG.ENDPOINT,
                 AZURE_SEARCH_CONFIG.INDEX_NAME,
                 new AzureKeyCredential(AZURE_SEARCH_CONFIG.ADMIN_KEY)
             );
        } else {
            this.logger.warn("Azure AI Search Admin Key no configurada. El cliente de indexación no estará disponible.");
             // @ts-ignore
            this.adminClient = null;
        }
    }

    /**
     * Obtiene el cliente de búsqueda (para consultas).
     * Lanza un error si no está configurado.
     */
    getSearchClient(): SearchClient<any> {
        if (!this.searchClient) {
            throw new Error("El cliente de búsqueda de Azure AI Search no está inicializado (falta Query Key?).");
        }
        return this.searchClient;
    }

     /**
      * Obtiene el cliente de administración (para indexar).
      * Lanza un error si no está configurado.
      */
     getAdminClient(): SearchClient<any> {
         if (!this.adminClient) {
             throw new Error("El cliente de administración de Azure AI Search no está inicializado (falta Admin Key?).");
         }
         return this.adminClient;
     }
}