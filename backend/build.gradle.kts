// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

plugins {
    java
}

group = "dev.mosaicast.plugin"
version = "2.8.0"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    // Dev-time alternative per ARCHITECTURE §3.5 (mavenLocal/includeBuild against an SDK checkout).
    mavenLocal()
    mavenCentral()
    maven {
        name = "mosaicastPluginSdk"
        url = uri("https://maven.pkg.github.com/Mosaicast/mosaicast-plugin-sdk")
        credentials {
            // GitHub Packages requires auth even for public reads. gpr.* gradle properties win locally;
            // GITHUB_ACTOR/GITHUB_TOKEN cover CI without committing anything.
            username = providers.gradleProperty("gpr.user").orElse(providers.environmentVariable("GITHUB_ACTOR")).orNull
            password = providers.gradleProperty("gpr.token").orElse(providers.environmentVariable("GITHUB_TOKEN")).orNull
        }
    }
}

dependencies {
    compileOnly("dev.mosaicast:plugin-api:0.7.1")
    compileOnly("org.pf4j:pf4j:3.15.0")
    annotationProcessor("org.pf4j:pf4j:3.15.0") // generates the PF4J extension index for @Extension

    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testImplementation("dev.mosaicast:plugin-testkit:0.7.1")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}

tasks.jar {
    archiveFileName.set("sample.jar")
}
