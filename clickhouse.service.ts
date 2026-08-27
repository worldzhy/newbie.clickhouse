import {Injectable, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {ClickHouseClient, createClient} from '@clickhouse/client';

@Injectable()
export class ClickhouseService implements OnModuleInit, OnModuleDestroy {
  private readonly client: ClickHouseClient;

  constructor(private readonly configService: ConfigService) {
    // Read the shared ClickHouse configuration through NestJS configuration services.
    const url = this.configService.getOrThrow<string>('microservices.clickhouse.url') || 'http://localhost:8123';
    const username = this.configService.get<string>('microservices.clickhouse.username') || 'default';
    const password = this.configService.get<string>('microservices.clickhouse.password') || '';
    const database = this.configService.get<string | undefined>('microservices.clickhouse.database');

    this.client = createClient({
      url,
      username,
      password,
      database,
    });
  }

  async query(options: Parameters<ClickHouseClient['query']>[0]) {
    return this.client.query(options);
  }

  async insert(options: Parameters<ClickHouseClient['insert']>[0]) {
    return this.client.insert(options);
  }

  async onModuleInit(): Promise<void> {
    // Verify connectivity on startup by running a lightweight ping query.
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }
}
