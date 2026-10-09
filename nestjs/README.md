<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/nestjs

[Zanbug](https://zanbug.com) error and performance monitoring for NestJS.

```bash
npm install @zanbug/nestjs
```

## Why the adapter

Nest wraps request handling in its own exception layer, so a throwing controller never reaches `uncaughtException` — it goes to the registered exception filter. Hooking that filter is the only way to see controller errors.

## Setup

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { ZanbugModule } from '@zanbug/nestjs';

@Module({
  imports: [
    ZanbugModule.forRoot({
      apiKey: process.env.ZANBUG_API_KEY,
      host: 'https://zanbug.com',
      release: process.env.APP_VERSION,
      environment: process.env.NODE_ENV,
    }),
  ],
})
export class AppModule {}
```

```ts
// main.ts
import { NestFactory } from '@nestjs/core';
import { ZanbugExceptionFilter } from '@zanbug/nestjs';
import { AppModule } from './app.module';

const app = await NestFactory.create(AppModule);
app.useGlobalFilters(new ZanbugExceptionFilter());
await app.listen(3000);
```

Each report carries the HTTP method, the route pattern and the status code.

## Keeping your own filter

By default the exception is rethrown so Nest's built-in filter formats the response. If you already have a filter that shapes error responses, hand it through:

```ts
app.useGlobalFilters(
  new ZanbugExceptionFilter((exception, host) => myFilter.catch(exception, host)),
);
```

## What counts as an error

An `HttpException` with a 4xx status is the app telling the client it did something wrong, not a defect — those are skipped. Everything else is reported.

## Injecting the client

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ZANBUG_CLIENT, capture } from '@zanbug/nestjs';

@Injectable()
export class OrdersService {
  constructor(@Inject(ZANBUG_CLIENT) private readonly zanbug) {}

  async run() {
    try {
      await this.work();
    } catch (err) {
      capture(err, { handled: true, context: { service: 'orders' } });
    }
  }
}
```

## Slow database queries

```ts
import { zanbugNestTypeOrmLogger } from '@zanbug/nestjs';

TypeOrmModule.forRoot({ ...options, logger: zanbugNestTypeOrmLogger() });
```

Prisma, Knex and `pg` hooks are available from [`@zanbug/node`](https://www.npmjs.com/package/@zanbug/node), which is bundled in.

## Updating
```bash
npx zanbug check     # exit 10 when a newer version is published
npx zanbug update    # upgrades @zanbug/node and @zanbug/nestjs together, with your package manager
```
Automatic: `initNode({ autoUpdate: true })` or `ZANBUG_AUTO_UPDATE=true` — daily check after init, update runs detached; restart the process afterwards. Details in the [@zanbug/node README](../node/README.md#updating-the-sdk).

## License

MIT
