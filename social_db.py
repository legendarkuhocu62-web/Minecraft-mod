import json
import os

DB_FILE = "social_db.json"


def load_db() -> dict:
  if not os.path.exists(DB_FILE):
    return {"users": {}}
  with open(DB_FILE, "r", encoding="utf-8") as f:
    data = json.load(f)
  data.setdefault("users", {})
  return data


def save_db(data: dict) -> None:
  with open(DB_FILE, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)


def normalize_tag(tag: str) -> str:
  clean = tag.strip().upper().lstrip("#")
  return f"#{clean}"


def _ensure_user(data: dict, user_id: int | str) -> dict:
  uid = str(user_id)
  return data["users"].setdefault(uid, {"main_tag": None, "friends": []})


def set_main_tag(user_id: int | str, tag: str) -> tuple[bool, str]:
  data = load_db()
  norm = normalize_tag(tag)
  if len(norm) < 4:
    return False, "Слишком короткий тег."

  user = _ensure_user(data, user_id)
  user["main_tag"] = norm
  save_db(data)
  return True, f"Привязал твой основной тег `{norm}`."


def get_main_tag(user_id: int | str) -> str | None:
  data = load_db()
  return data["users"].get(str(user_id), {}).get("main_tag")


def add_friend(user_id: int | str, friend_tag: str) -> tuple[bool, str]:
  data = load_db()
  norm = normalize_tag(friend_tag)
  if len(norm) < 4:
    return False, "Слишком короткий тег."

  user = _ensure_user(data, user_id)
  if user["main_tag"] == norm:
    return False, "Нельзя добавить самого себя в друзья."

  if norm in user["friends"]:
    return False, f"Тег `{norm}` уже есть в твоём списке друзей."

  user["friends"].append(norm)
  save_db(data)
  return True, f"Добавил `{norm}` в список друзей."


def remove_friend(user_id: int | str, friend_tag: str) -> tuple[bool, str]:
  data = load_db()
  norm = normalize_tag(friend_tag)
  user = _ensure_user(data, user_id)

  if norm not in user["friends"]:
    return False, f"Тега `{norm}` нет в твоём списке друзей."

  user["friends"].remove(norm)
  save_db(data)
  return True, f"Удалил `{norm}` из списка друзей."


def get_friends(user_id: int | str) -> list[str]:
  data = load_db()
  return data["users"].get(str(user_id), {}).get("friends", [])


def find_users_with_friend(target_tag: str) -> list[str]:
  """Возвращает список Discord ID пользователей, у которых в друзьях есть target_tag."""
  data = load_db()
  norm = normalize_tag(target_tag)
  return [
      uid
      for uid, info in data["users"].items()
      if norm in info.get("friends", [])
  ]


def find_user_by_main_tag(target_tag: str) -> str | None:
  """Находит Discord ID пользователя по его привязанному main_tag."""
  data = load_db()
  norm = normalize_tag(target_tag)
  for uid, info in data["users"].items():
    if info.get("main_tag") == norm:
      return uid
  return None


def get_mutual_friends(user_a: int | str, user_b: int | str) -> list[str]:
  """Общие теги друзей между двумя пользователями."""
  friends_a = set(get_friends(user_a))
  friends_b = set(get_friends(user_b))
  return sorted(friends_a & friends_b)
