import type { LogEntry } from './types';

export class Logger {
  public logs: LogEntry[] = [];

  private add(level: LogEntry['level'], message: string, data?: any) {
    this.logs.push({
      level,
      message,
      timestamp: new Date().toISOString(),
      data,
    });
  }

  info(message: string, data?: any) {
    this.add('info', message, data);
  }

  warn(message: string, data?: any) {
    this.add('warn', message, data);
  }
  
  error(message: string, data?: any) {
    this.add('error', message, data);
  }

  success(message: string, data?: any) {
    this.add('success', message, data);
  }
}