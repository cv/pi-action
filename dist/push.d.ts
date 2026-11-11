export declare function pushThread(payload: Record<string, unknown>, cwd: string, log: {
    info: (m: string) => void;
    warning: (m: string) => void;
}, remote?: string): Promise<"pushed" | "nothing" | "failed">;
