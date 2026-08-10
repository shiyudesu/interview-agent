import type {
  PgQuestionBankRepository,
  QuestionBankImportRequest,
  QuestionBankImportResult,
} from "../repositories/question-bank-repository.js";

export class QuestionBankImportService {
  constructor(private readonly repository: PgQuestionBankRepository) {}

  synchronize(request: QuestionBankImportRequest): Promise<QuestionBankImportResult> {
    return this.repository.synchronize(request);
  }
}
