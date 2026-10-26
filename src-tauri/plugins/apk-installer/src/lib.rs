//! Установка скачанного APK: на Android показывает системное окно «Установить».

use std::path::Path;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

/// Android ещё не разрешил приложению ставить APK — открыли нужный экран настроек.
pub const NEED_PERMISSION: &str = "NEED_PERMISSION";

pub struct ApkInstaller<R: Runtime> {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "android"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> ApkInstaller<R> {
    pub fn install(&self, path: &Path) -> Result<(), String> {
        #[cfg(target_os = "android")]
        {
            self.handle
                .run_mobile_plugin::<serde_json::Value>(
                    "install",
                    serde_json::json!({ "path": path.to_string_lossy() }),
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = path;
            Err("Установка APK есть только на Android".into())
        }
    }
}

pub trait ApkInstallerExt<R: Runtime> {
    fn apk_installer(&self) -> &ApkInstaller<R>;
}

impl<R: Runtime, T: Manager<R>> ApkInstallerExt<R> for T {
    fn apk_installer(&self) -> &ApkInstaller<R> {
        self.state::<ApkInstaller<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-installer")
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let handle = _api.register_android_plugin("by.tomashevich.apkinstaller", "ApkInstallerPlugin")?;
            app.manage(ApkInstaller::<R> {
                #[cfg(target_os = "android")]
                handle,
                #[cfg(not(target_os = "android"))]
                _marker: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}
