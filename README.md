# ⚡ BMS Pro — Mạch Quản Lý Pin Thông Minh (ESP32 + SH367309)

Hệ thống giám sát, phân tích và điều khiển Pack pin 10S 36V Lithium-ion / LiFePO4 theo thời gian thực.

## 🚀 Tính Năng Chính
- **Giám sát thời gian thực**: Điện áp tổng (V), Dòng sạc/xả (A), Công suất (W), Nhiệt độ (°C).
- **Chi tiết từng Cell**: Đo chính xác điện áp 10 cell qua chip **SH367309**, cảnh báo độ lệch Delta V.
- **Thuật toán tiên tiến**: Ước tính dung lượng pin **SoC (AEKF - Adaptive Extended Kalman Filter)** & phát hiện lỗi sớm **CUSUM**.
- **Thu thập dữ liệu dài hạn (1-2 tháng)**: Ghi log chu kỳ, ước tính dung lượng, xuất dữ liệu CSV / Excel / JSON.
- **Điều khiển & Bảo vệ**: Bật/tắt MOSFET sạc/xả, Rơ-le quạt làm mát, Buzzer, LED RGB.
- **In báo cáo (Print Sheet)**: Tối ưu chuẩn in A4 làm hồ sơ kỹ thuật kiểm định.

## 📂 Cấu Trúc Thư Mục
```text
├── index.html       # Giao diện Dashboard 6 tab
├── style.css        # Hệ thống giao diện Dark Glassmorphism
├── app.js           # Logic xử lý, thuật toán Kalman/CUSUM, biểu đồ thời gian thực
└── README.md        # Tài liệu dự án
```

## 🌐 Trải Nghiệm Trực Tuyến
Trang web được thiết kế dạng Static Web thuần túy (HTML/CSS/JS), có thể chạy trực tiếp trên **GitHub Pages** mà không cần cấu hình server phức tạp.
