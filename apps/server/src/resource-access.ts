import type { AccountId, InterviewId } from "@interview-agent/domain";

export interface OwnedInterviewReader<InterviewResource> {
  findById(interviewId: InterviewId, accountId: AccountId): Promise<InterviewResource | null>;
}

export interface OwnedReportReader<Report> {
  findByInterviewId(interviewId: InterviewId, accountId: AccountId): Promise<Report | null>;
}

export class OwnedResourceNotFoundError extends Error {
  constructor(readonly resource: "interview" | "report") {
    super(`${resource} was not found`);
    this.name = "OwnedResourceNotFoundError";
  }
}

export class ResourceAccessService<InterviewResource, Report> {
  constructor(
    private readonly interviews: OwnedInterviewReader<InterviewResource>,
    private readonly reports: OwnedReportReader<Report>,
  ) {}

  async requireInterview(
    accountId: AccountId,
    interviewId: InterviewId,
  ): Promise<InterviewResource> {
    const interview = await this.interviews.findById(interviewId, accountId);
    if (interview === null) {
      throw new OwnedResourceNotFoundError("interview");
    }
    return interview;
  }

  async requireReport(accountId: AccountId, interviewId: InterviewId): Promise<Report> {
    const report = await this.reports.findByInterviewId(interviewId, accountId);
    if (report === null) {
      throw new OwnedResourceNotFoundError("report");
    }
    return report;
  }
}
