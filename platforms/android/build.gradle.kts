plugins {
    id("com.android.application") version "9.4.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
}

// Windows Java argument files do not reliably load classes from non-ASCII paths.
// Keep generated files in an ASCII cache; source files stay in the checkout.
if (System.getProperty("os.name").startsWith("Windows")) {
    val root = System.getenv("SHUFANG_ANDROID_BUILD_DIR")
        ?: "${System.getenv("LOCALAPPDATA")}/Shufang/android-build"
    allprojects { layout.buildDirectory.set(file("$root/${project.name}")) }
}
