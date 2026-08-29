# קופת לוטו משפחתית

## מבנה
- `server/` – Express + SQLite (better-sqlite3), הכל בקובץ DB אחד.
- `server/public/` – הפרונטאנד (Vanilla HTML/JS), מוגש ישירות מהשרת.
- `docker-compose.yml` – Stack ל-Portainer.
- `.github/workflows/build-and-deploy.yml` – בונה ודוחף image ל-ghcr.io בכל push.

## הרשאות
- **צופה**: כל מי שיש לו את הקישור, בלי סיסמה. יכול לראות הכל, לא יכול לשנות כלום.
- **מנהל**: מתחבר עם סיסמה משותפת אחת (`ADMIN_PASSWORD`). כדי "להוסיף מנהל" – פשוט משתפים את הסיסמה עם עוד בן משפחה. הטוקן נשמר בדפדפן שלו (localStorage), תקף ל-12 שעות ואז צריך להתחבר שוב.
- אין למחוק חבר במובן האמיתי – יש כפתור "פרש" (soft delete) ששומר את ההיסטוריה שלו ופשוט מוציא אותו מהגרלות עתידיות. אפשר להחזיר.

## הגיון החישוב (למה אין יותר את הבאג של "חלוקה לא הוגנת")
כל הגרלה (עלות + זכיה) מתחלקת שווה בשווה בין החברים ה**פעילים** באותו רגע, ונשמרת ככה לתמיד (טבלת `draw_shares`). ההפקדות וההוצאות של כל חבר נצברות ל"יתרה אישית" (ledger) עצמאית – הפקדה של מישהו לא משפיעה על היתרה של אף אחד אחר.

## הרצה מקומית (בדיקה)
```bash
cd server
npm install
ADMIN_PASSWORD=test123 npm start
# http://localhost:3000
```

## פריסה על סינולוג'י + Portainer

1. **צור repo ב-GitHub**, דחוף אליו את כל התיקייה הזו.
2. ב-GitHub → Settings → Actions יש הרשאה אוטומטית ל-`GITHUB_TOKEN` לדחוף ל-ghcr.io – לא צריך secret נוסף לצעד הזה.
3. ערוך את `docker-compose.yml`:
   - `ghcr.io/YOUR_GITHUB_USERNAME/kupat-lotto:latest` → שם המשתמש שלך.
   - `ADMIN_PASSWORD` → סיסמה אמיתית וחזקה.
   - נתיב ה-volume → תיקייה אמיתית בנאס (למשל `/volume1/docker/kupat-lotto/data`).
4. **ב-Portainer**: Stacks → Add stack → הדבק את תוכן ה-compose (או חבר ל-repo של git ישירות דרך Portainer, אם תרצה גם שם auto-pull).
5. אם ה-package ב-GHCR פרטי – בפעם הראשונה יהיה צריך ב-Portainer Registries להוסיף את ghcr.io עם Personal Access Token (`read:packages`), או להפוך את ה-package ל-Public דרך GitHub.

### עדכון אוטומטי בכל push
בחר אחת מהשתיים:
- **Watchtower** – קונטיינר נוסף שבודק image חדש ומריץ אוטומטית. הכי פשוט, בלי הגדרות ב-GitHub.
- **Portainer Webhook** – ב-Portainer, בתוך ה-Stack → Webhooks → צור webhook, העתק את ה-URL, שמור אותו ב-GitHub כ-secret בשם `PORTAINER_WEBHOOK_URL` (Settings → Secrets and variables → Actions). מעכשיו כל push ל-`main` יבנה image חדש **וגם** יגיד ל-Portainer להריץ אותו מיד.

### גישה מרחוק
מומלץ **Tailscale** במקום לחשוף פורט לאינטרנט – כל בן משפחה מתקין אפליקציה, מתחבר ישירות לנאס בפרטיות. אם מעדיפים reverse proxy + Cloudflare Zero Trust שכבר קיים אצלך – עדיף להגן על הנתיב גם ב-Cloudflare Access (לא רק בסיסמת המנהל של האפליקציה).

## גיבויים
- כל `reset` שומר גיבוי אוטומטי בתיקיית `data/backups/` לפני מחיקה.
- כפתור "הורד גיבוי JSON" בממשק (למנהל) מייצא את כל הנתונים בכל רגע.
- מומלץ להוסיף את `/volume1/docker/kupat-lotto/data` לתזמון ה-snapshot/backup הרגיל של הסינולוג'י.
