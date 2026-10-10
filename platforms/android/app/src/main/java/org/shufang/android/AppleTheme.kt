package org.shufang.android

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val day = lightColorScheme(
    primary=Color(0xFF263F39), onPrimary=Color.White,
    primaryContainer=Color(0xFFE6ECE8), onPrimaryContainer=Color(0xFF263F39),
    secondary=Color(0xFF6A7569), secondaryContainer=Color(0xFFECEEE8), onSecondaryContainer=Color(0xFF35433B),
    tertiary=Color(0xFF248A3D), tertiaryContainer=Color(0xFFE8F5EC),
    background=Color(0xFFF8F7F4), onBackground=Color(0xFF242623),
    surface=Color.White, onSurface=Color(0xFF242623),
    surfaceVariant=Color(0xFFEDECE7), onSurfaceVariant=Color(0xFF6B7068),
    surfaceContainer=Color.White, surfaceContainerLow=Color.White,
    surfaceContainerLowest=Color.White, surfaceContainerHigh=Color(0xFFF8F7F4),
    surfaceContainerHighest=Color(0xFFEDECE7), outline=Color(0xFF8E8E93), outlineVariant=Color(0xFFE2E2DB),
    error=Color(0xFFB42318), errorContainer=Color(0xFFFFEBE9), onErrorContainer=Color(0xFF8F1D14)
)
private val night = darkColorScheme(
    primary=Color(0xFFBBCDBF), onPrimary=Color(0xFF18251D),
    primaryContainer=Color(0xFF2F3D35), onPrimaryContainer=Color(0xFFD6E6DA),
    secondary=Color(0xFFC8C9B8), secondaryContainer=Color(0xFF35382F), onSecondaryContainer=Color(0xFFE0E2D7),
    background=Color(0xFF141614), onBackground=Color(0xFFF8F7F4),
    surface=Color(0xFF242623), onSurface=Color(0xFFF8F7F4),
    surfaceVariant=Color(0xFF38383A), onSurfaceVariant=Color(0xFFAEAEB2),
    surfaceContainer=Color(0xFF242623), surfaceContainerLow=Color(0xFF242623),
    surfaceContainerLowest=Color(0xFF141614), surfaceContainerHigh=Color(0xFF2C2C2E),
    surfaceContainerHighest=Color(0xFF38383A), outline=Color(0xFF8E8E93), outlineVariant=Color(0xFF38383A)
)

/** System fonts keep Chinese readable without shipping proprietary Apple fonts. */
val LocalInkMode=compositionLocalOf {false}
private val eInk=lightColorScheme(primary=Color.Black,onPrimary=Color.White,primaryContainer=Color(0xFFE0E0E0),onPrimaryContainer=Color.Black,background=Color.White,onBackground=Color.Black,surface=Color.White,onSurface=Color.Black,onSurfaceVariant=Color(0xFF333333),outline=Color(0xFF555555),outlineVariant=Color(0xFF999999),surfaceVariant=Color(0xFFEEEEEE))
@Composable fun AppleTheme(inkMode:Boolean=false,content:@Composable ()->Unit) {
    CompositionLocalProvider(LocalInkMode provides inkMode) {
    MaterialTheme(
        colorScheme=if(inkMode)eInk else if(isSystemInDarkTheme())night else day,
        shapes=Shapes(extraSmall=RoundedCornerShape(8.dp),small=RoundedCornerShape(12.dp),medium=RoundedCornerShape(18.dp),large=RoundedCornerShape(24.dp),extraLarge=RoundedCornerShape(30.dp)),
        typography=Typography(
            headlineLarge=TextStyle(fontFamily=FontFamily.SansSerif,fontWeight=FontWeight.Bold,fontSize=30.sp,lineHeight=39.sp,letterSpacing=(-0.6).sp),
            titleLarge=TextStyle(fontWeight=FontWeight.Bold,fontSize=23.sp,lineHeight=30.sp,letterSpacing=(-0.4).sp),
            titleMedium=TextStyle(fontWeight=FontWeight.SemiBold,fontSize=17.sp,lineHeight=24.sp),
            bodyLarge=TextStyle(fontSize=16.sp,lineHeight=26.sp),
            bodyMedium=TextStyle(fontSize=15.sp,lineHeight=23.sp),
            labelLarge=TextStyle(fontWeight=FontWeight.SemiBold,fontSize=15.sp,lineHeight=20.sp)
        ),content=content
    )
    }
}
