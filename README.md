# LingoPulse – Personal Learning Dashboard + AI Pronunciation + AI Tutor

## Đã nâng cấp
- Sidebar trái cố định, có thể thu gọn; mobile chuyển thành drawer.
- Dashboard cá nhân: XP, streak, mastery, từ cần ôn, biểu đồ 7 ngày, phát âm trung bình.
- Lưu kết quả kiểm tra vào localStorage; Supabase có bảng `learning_attempts` và `word_mastery` để mở rộng đồng bộ đa thiết bị.
- Mastery + danh sách từ yếu.
- Spaced Repetition kiểu SM-2 đơn giản: ease, interval, due date.
- Streak + XP cho Flashcards, Quiz, Nghe & Viết, phát âm AI và Ghép từ.
- Bảng vinh danh Top 20 Supabase.
- Thành tích/badges.
- Quote/động lực mỗi ngày.
- AI Tutor cá nhân hóa theo XP, streak, từ yếu, số lượt luyện và điểm phát âm.
- Mobile responsive.
- Luyện phát âm: microphone → ghi âm → nghe lại → AI chấm điểm.

## Chạy
```bash
npm install
npm start
```
Mở `http://localhost:3000`.

## Supabase
Chạy toàn bộ `supabase_leaderboard.sql` trong Supabase SQL Editor.

## Environment
Tạo `.env`:
```env
PORT=3000
OPENAI_API_KEY=...
OPENAI_TUTOR_MODEL=gpt-4o-mini
SUPABASE_URL=...
SUPABASE_PUBLISHABLE_KEY=...
```
Không commit `.env`.

## Kiểm thử trước Render
1. `npm install`
2. `node --check server.mjs`
3. Mở `http://localhost:3000`
4. Kiểm tra sidebar thu gọn/mở rộng.
5. Kiểm tra Quiz, Spelling, microphone, AI pronunciation.
6. Kiểm tra XP/streak/mastery/từ yếu/achievement.
7. Đăng nhập Supabase và kiểm tra leaderboard.
8. Kiểm tra AI Tutor.
9. Test trên mobile viewport.
