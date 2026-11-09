package by.tomashevich.apkinstaller

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

/** Свой класс, чтобы не конфликтовать с FileProvider самого Tauri. */
class UpdateFileProvider : FileProvider()

@InvokeArg
class InstallArgs {
    lateinit var path: String
}

@InvokeArg
class IconArgs {
    lateinit var name: String
}

private val ICONS = listOf("lilac", "night", "minimal", "mint", "sunset", "letter", "cap", "book", "owl", "planet", "rocket", "bulb", "pencil", "coffee")
// Иконки из 0.3.0, которых больше нет: их ярлыки остались в манифесте, чтобы выключить их при смене.
private val OLD_ICONS = listOf("gradient", "ocean", "calendar", "notebook", "pixel", "mono")

@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun install(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallArgs::class.java)
            val file = File(args.path).canonicalFile
            val updates = File(activity.cacheDir, "updates").canonicalFile
            // Ставим только то, что приложение само скачало в свою папку обновлений.
            if (file.parentFile != updates || !file.name.endsWith(".apk") || !file.isFile) {
                invoke.reject("Файл обновления не найден")
                return
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                !activity.packageManager.canRequestPackageInstalls()
            ) {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.packageName)
                    )
                )
                invoke.reject("NEED_PERMISSION")
                return
            }
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".updates", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Не удалось открыть установку")
        }
    }

    /** Иконка на рабочем столе: включаем нужный ярлык, остальные выключаем. */
    @Command
    fun setIcon(invoke: Invoke) {
        try {
            val name = invoke.parseArgs(IconArgs::class.java).name
            if (name !in ICONS) {
                invoke.reject("Нет такой иконки")
                return
            }
            val pm = activity.packageManager
            val alias = { n: String -> ComponentName(activity.packageName, "by.tomashevich.unitrack.Icon" + n.replaceFirstChar { it.uppercase() }) }
            // Сначала включаем новую, потом выключаем остальные — чтобы ярлык не пропадал совсем.
            pm.setComponentEnabledSetting(alias(name), PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            for (n in ICONS + OLD_ICONS) if (n != name) {
                pm.setComponentEnabledSetting(alias(n), PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            }
            invoke.resolve()
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Не удалось сменить иконку")
        }
    }
}
