import asyncio
import sys
sys.path.insert(0, ".")

from slot_bot.db import make_engine, init_models


async def main():
    engine = make_engine("postgresql://postgres:postgres@localhost:5432/slot_test")
    await init_models(engine)
    print("schema created OK")
    await engine.dispose()


asyncio.run(main())
