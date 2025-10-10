export type LogLevel = 'STEP' | 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: string;
    step?: string;
    data?: any;
}

export class Logger {
    private logs: LogEntry[] = [];
    private currentStep: string = '初始化';
    private isSilent: boolean = false;

    constructor(options: { silent?: boolean } = {}) {
        this.isSilent = options.silent || false;
    }

    private add(level: LogLevel, message: string, data?: any) {
        if (this.isSilent) return;
        this.logs.push({
            level,
            message,
            timestamp: new Date().toISOString(),
            step: this.currentStep,
            data,
        });
    }

    step(name: string) {
        this.currentStep = name;
        this.add('STEP', `开始步骤: ${name}`);
    }

    info(message: string, data?: any) {
        this.add('INFO', message, data);
    }

    success(message: string, data?: any) {
        this.add('SUCCESS', message, data);
    }

    warn(message: string, data?: any) {
        this.add('WARN', message, data);
    }

    error(message: string, data?: any) {
        this.add('ERROR', message, data);
    }
    
    debug(message: string, data?: any) {
        this.add('DEBUG', message, data);
    }

    getLogs(): LogEntry[] {
        return this.isSilent ? [] : [...this.logs];
    }

    print() {
        if (this.isSilent) return;
        console.log("\n\n");
        console.log("==================================================");
        console.log(`上帝视角日志: ${new Date().toISOString()}`);
        console.log("==================================================");

        this.logs.forEach(log => {
            let color = '\x1b[0m'; // Reset
            let icon = '';

            switch (log.level) {
                case 'STEP':
                    color = '\x1b[35m'; // Magenta
                    icon = '🚀';
                    break;
                case 'INFO':
                    color = '\x1b[36m'; // Cyan
                    icon = 'ℹ️';
                    break;
                case 'SUCCESS':
                    color = '\x1b[32m'; // Green
                    icon = '✅';
                    break;
                case 'WARN':
                    color = '\x1b[33m'; // Yellow
                    icon = '⚠️';
                    break;
                case 'ERROR':
                    color = '\x1b[31m'; // Red
                    icon = '❌';
                    break;
                case 'DEBUG':
                    color = '\x1b[90m'; // Gray
                    icon = '🐞';
                    break;
            }

            if (log.level === 'STEP') {
                console.log(`\n${color}================== ${icon} [${log.step}] ==================\x1b[0m`);
            } else {
                console.log(`${color}${icon} [${log.level}] [${log.step}] ${log.message}\x1b[0m`);
                if (log.data) {
                    console.log(`${color}   └─ DATA: ${JSON.stringify(log.data, null, 2)}\x1b[0m`);
                }
            }
        });
        console.log("==================================================");
        console.log("上帝视角日志结束");
        console.log("==================================================\n\n");
    }
}