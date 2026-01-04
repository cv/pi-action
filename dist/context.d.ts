export declare function hasTrigger(text: string, trigger: string): boolean;
export declare function extractTask(comment: string, trigger: string): string;
export interface PIContext {
    type: "issue" | "pull_request";
    title: string;
    body: string;
    number: number;
    triggerComment: string;
    task: string;
    diff?: string;
}
export declare function renderTemplate(template: string, context: PIContext): string;
export declare function buildPrompt(context: PIContext, customTemplate?: string): string;
