import {Global, Module} from '@nestjs/common';
import {ClickhouseService} from '../clickhouse/clickhouse.service';

@Global()
@Module({
  providers: [ClickhouseService],
  exports: [ClickhouseService],
})
export class ClickhouseModule {}
