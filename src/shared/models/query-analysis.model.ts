// src/shared/models/query-analysis.model.ts

export interface EnhancedQueryAnalysis {
  requiresComparison: boolean;
  requiresRanking: boolean; 
  requiresCalculation: boolean;
  searchType: 'simple' | 'comparative' | 'superlative' | 'analytical';
  entities: string[];
  keyTerms: string[];
  complexity: 'simple' | 'complex';
  confidence: number;
  suggestedSearchQueries: string[];
}

export interface QueryUnderstanding {
  intents: string[];
  entities: string[];
  modifiers: string[];
  requiresCalculation: boolean;
  complexity: 'simple' | 'complex';
  language: string;
  confidence: number;
  // NUEVOS CAMPOS:
 searchType?: "simple" | "comparative" | "superlative" | "analytical" | "list_all"; // Updated definition
  suggestedQueries?: string[];
}

export interface EnhancedSearchQuery {
  text: string;
  weight: number;
  metadata: {
    isOriginal?: boolean;
    isSimplified?: boolean;
    focus?: string;
    isAiSuggested?: boolean;
    searchType?: string;
  };
}

export interface EnhancedQueryAnalysis {
  requiresComparison: boolean;
  requiresRanking: boolean;
  requiresCalculation: boolean;
  searchType: 'simple' | 'comparative' | 'superlative' | 'analytical';
  entities: string[];
  keyTerms: string[];
  complexity: 'simple' | 'complex';
  confidence: number;
  suggestedSearchQueries: string[];
}

export interface ContextAnalysis {
  hasStructuredData: boolean;
  dataTypes: string[];
  requiresComparison: boolean;
  hasNumericContent: boolean;
  contentPatterns: string[];
  dominantLanguage: string;
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  suggestions: string[];
  confidence: number;
}

export interface ValidationIssue {
  type: 'unverified_number' | 'invalid_comparison' | 'ambiguous_reference';
  value?: number;
  claim: string;
  suggestion?: string;
}

export interface Claim {
  text: string;
  hasNumericValue: boolean;
  hasComparison: boolean;
  entities: string[];
  value?: number;
  comparisonType?: 'greater' | 'lesser';
}