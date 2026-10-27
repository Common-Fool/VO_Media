"""Действия с файлами (Windows-часть): проводник, внешний плеер, переименование, удаление в корзину, буфер обмена.

Маршруты /api/explorer, /api/player*, /api/play, /api/file/* сервер отдаёт сюда целиком (route()).
Пока заглушка: реализация — пункт 25 плана (docs/CONTRACT.md, раздел «v0.2»).
"""
import logging

log = logging.getLogger(__name__)

PREFIXES = frozenset({'explorer', 'player', 'play', 'file'})


def handles(p):
    """Маршрут ли это файловых действий (p — путь, разбитый по '/')."""
    return len(p) >= 2 and p[0] == 'api' and p[1] in PREFIXES


def route(ctx, post, p, q, raw):
    """Обработать запрос. Вернуть (код HTTP, объект JSON). ValueError — ошибка для пользователя (сервер ответит 409)."""
    return 501, {'error': 'not implemented yet'}
