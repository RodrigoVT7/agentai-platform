export interface QuestionnaireSubmission {
  id: string;
  userId: string;
  status: "draft" | "ready";
  agentId: string;
  questionnaireAnswers: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  _partitionKey?: string;
}

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  required: boolean;
  options?: string[];
  order: number;
}

export enum QuestionType {
  TEXT = "text",
  MULTIPLE_CHOICE = "multiple_choice",
  SINGLE_CHOICE = "single_choice",
  TRUE_FALSE = "true_false",
  NUMERIC = "numeric",
  DATE = "date",
}

export interface Answer {
  questionId: string;
  value: string | string[] | number | boolean;
  isCorrect?: boolean;
}

export interface QuestionnaireSubmissionSearchParams {
  agentId?: string;
  userId?: string;
  status?: "draft" | "ready";
  limit?: number;
  skip?: number;
}

export interface QuestionnaireSubmissionCreateRequest {
  userId: string;
  agentId: string;
  questionnaireAnswers: Record<string, any>;
  status?: "draft" | "ready";
}

export interface QuestionnaireSubmissionUpdateRequest {
  questionnaireAnswers?: Record<string, any>;
  status?: "draft" | "ready";
}

export interface QuestionnaireSubmissionSubmitRequest {
  questionnaireSubmissionId: string;
  userId: string;
  answers: Answer[];
}
