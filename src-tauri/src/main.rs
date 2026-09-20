// main.rs
// Firefly AI Engine 可执行入口

// 防止 Windows 上额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    firefly_ai_engine_lib::run()
}
